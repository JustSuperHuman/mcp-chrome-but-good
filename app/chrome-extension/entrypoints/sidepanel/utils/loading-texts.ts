/**
 * Random loading messages
 * Playful waiting hints shown by the TimelineStatusStep component
 */

const loadingTexts = [
  // Classic memes
  'This was supposed to be calm and effortless',
  'Now it is a mad scramble',
  "I know you're in a hurry, but hang on",
  'Doggy-paddling through the sea of knowledge',
  'Let the bullets fly a little longer',
  'Hand-crafting your answer',
  'Rallying the little goblins',
  'Already on it (just made a New Folder)',
  'Sweating bullets over this one',
  'The CPU is about to melt',
  // Everyday life
  'Slow-roasting, good things take time',
  'Flipping the knowledge pancake',
  'Raising a glass to myself, almost done',
  'Popping the inspiration in the oven',
  'Letting the answer steep a little longer',
  'Maxing out the good vibes',
  'Knitting you a sweater of words',
  // Wild ideas
  'Neurons hitting the dance floor',
  'A night owl is pondering',
  'Coloring in the answer',
  'Frantically flipping through the knowledge base',
  'The brain circus is in town',
  'Squishing 0s and 1s together',
  'Charging up a special move',
  'The magnifying glass fogged up, wiping it',
  'Trying to make sense of this wild request',
  // Fantasy
  'Casting a spell, do not disturb',
  'Waking up our silicon friends',
  'Tapping into the wisdom of cyberspace',
  'Hold on, traveler, divining the answer',
  'Passing through a knowledge black hole',
  'Reverse-engineering human intent',
  'The crystal ball is cloudy, giving it a tap',
  // At work
  'Code running faster than the news',
  'The head chef is in, one moment',
  'Riding over at full gallop',
  'Hauling knowledge at light speed',
  'Placing the last piece of the puzzle',
  'The answer is almost a wrap',
  'Launch countdown in progress',
  'Locking on target',
];

/**
 * Get a random loading message
 */
export function getRandomLoadingText(): string {
  return loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
}
