import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  removeTabDocuments: vi.fn().mockResolvedValue(undefined),
  addDocument: vi.fn().mockResolvedValue(1),
  getStats: vi.fn().mockReturnValue({}),
}));
vi.mock('@/utils/vector-database', () => ({
  VectorDatabase: class {},
  getGlobalVectorDatabase: vi.fn(async () => database),
}));
vi.mock('@/utils/semantic-similarity-engine', () => ({
  SemanticSimilarityEngine: class {},
  SemanticSimilarityEngineProxy: class {
    isInitialized = true;
    async initialize() {}
    async getEmbedding() {
      return new Float32Array(384);
    }
  },
  PREDEFINED_MODELS: { 'multilingual-e5-small': { dimension: 384, modelIdentifier: 'test-model' } },
}));
import { ContentIndexer } from '@/utils/content-indexer';

describe('ContentIndexer lifecycle', () => {
  let indexer: ContentIndexer;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (chrome.storage.local.get as any).mockResolvedValue({});
    indexer = new ContentIndexer();
    await indexer.initialize();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers tab listeners only once across model changes', async () => {
    vi.spyOn(indexer as any, 'performCompleteDataCleanupForModelSwitch').mockResolvedValue(
      undefined,
    );
    await indexer.reinitialize();
    await indexer.reinitialize();
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated completion events into one indexing task', async () => {
    const index = vi.spyOn(indexer, 'indexTabContent').mockResolvedValue(undefined);
    const update = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];
    for (let i = 0; i < 20; i++) update(42, { status: 'complete' }, { url: 'https://example.com' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(index).toHaveBeenCalledTimes(1);
    expect(index).toHaveBeenCalledWith(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels deferred indexing for closed tabs and new navigations', async () => {
    const index = vi.spyOn(indexer, 'indexTabContent').mockResolvedValue(undefined);
    const update = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];
    const remove = (chrome.tabs.onRemoved.addListener as any).mock.calls[0][0];
    update(42, { status: 'complete' }, { url: 'https://example.com' });
    await remove(42);
    update(43, { status: 'complete' }, { url: 'https://example.com' });
    update(43, { status: 'loading' }, { url: 'https://example.com/next' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(index).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one cache entry per tab and releases it when the tab closes', async () => {
    vi.spyOn(indexer as any, 'extractTabContent').mockResolvedValue({
      textContent: 'A small test page.',
      title: 'Test',
    });
    vi.spyOn((indexer as any).textChunker, 'chunkText').mockReturnValue([
      { text: 'Test', index: 0 },
    ]);
    for (let i = 0; i < 40; i++) {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 42,
        url: `https://example.com/${i}`,
        title: 'Test',
      });
      await indexer.indexTabContent(42);
    }
    expect(indexer.getStats().indexedPages).toBe(1);
    const writes = database.addDocument.mock.calls.length;
    await indexer.indexTabContent(42);
    expect(database.addDocument).toHaveBeenCalledTimes(writes);
    await indexer.removeTabIndex(42);
    expect(indexer.getStats().indexedPages).toBe(0);
  });

  it('stops an embedding task from restoring a closed tab to the index cache', async () => {
    vi.spyOn(indexer as any, 'extractTabContent').mockResolvedValue({
      textContent: 'A page.',
      title: 'Test',
    });
    vi.spyOn((indexer as any).textChunker, 'chunkText').mockReturnValue([
      { text: 'Test', index: 0 },
    ]);
    (chrome.tabs.get as any).mockResolvedValue({
      id: 42,
      url: 'https://example.com',
      title: 'Test',
    });
    let completeEmbedding!: (value: Float32Array) => void;
    const embedding = vi.spyOn((indexer as any).semanticEngine, 'getEmbedding').mockImplementation(
      () =>
        new Promise<Float32Array>((resolve) => {
          completeEmbedding = resolve;
        }),
    );
    const indexing = indexer.indexTabContent(42);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(embedding).toHaveBeenCalledTimes(1);
    await indexer.removeTabIndex(42);
    completeEmbedding(new Float32Array(384));
    await indexing;
    expect(database.addDocument).not.toHaveBeenCalled();
    expect(indexer.getStats().indexedPages).toBe(0);
  });
});
