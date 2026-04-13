// Word lists for generating memorable room codes.
// Format: adjective-animal-## (e.g. "happy-tiger-42")

const adjectives = [
  "happy", "bold", "calm", "wise", "kind", "brave", "swift", "quiet",
  "bright", "gentle", "fierce", "soft", "sharp", "warm", "cool", "wild",
  "quick", "slow", "neat", "tidy", "clever", "merry", "jolly", "witty",
  "sunny", "misty", "dusty", "foggy", "rainy", "snowy", "stormy", "windy",
  "sleepy", "grumpy", "cheery", "dreamy", "eager", "loyal", "noble", "proud",
  "shy", "bashful", "curious", "friendly", "polite", "silent", "loud", "tiny",
  "giant", "mighty", "nimble", "sturdy", "fluffy", "smooth", "rough", "shiny",
  "dull", "fresh", "stale", "sweet", "bitter", "sour", "spicy", "salty",
  "crisp", "soggy", "firm", "tender", "ancient", "modern", "classic", "vintage",
  "rusty", "shiny", "golden", "silver", "bronze", "crimson", "azure", "emerald",
  "amber", "ruby", "pearl", "jade", "coral", "indigo", "violet", "scarlet",
  "ivory", "ebony", "onyx", "opal", "fuzzy", "glossy", "matte", "plush",
  "velvet", "silky", "rustic", "urban", "cozy", "breezy", "frosty", "balmy",
];

const animals = [
  "tiger", "lion", "wolf", "fox", "bear", "owl", "hawk", "eagle",
  "falcon", "sparrow", "robin", "crane", "heron", "swan", "goose", "duck",
  "whale", "dolphin", "otter", "seal", "shark", "octopus", "turtle", "crab",
  "panda", "koala", "sloth", "lemur", "monkey", "gorilla", "elephant", "rhino",
  "horse", "zebra", "giraffe", "camel", "llama", "alpaca", "deer", "elk",
  "moose", "bison", "buffalo", "yak", "goat", "sheep", "pig", "cow",
  "rabbit", "hare", "squirrel", "chipmunk", "beaver", "badger", "raccoon", "skunk",
  "hedgehog", "porcupine", "mole", "mouse", "rat", "hamster", "ferret", "weasel",
  "cat", "lynx", "cougar", "jaguar", "leopard", "cheetah", "ocelot", "puma",
  "parrot", "toucan", "macaw", "kiwi", "penguin", "pelican", "ibis", "stork",
  "frog", "newt", "gecko", "iguana", "chameleon", "komodo", "python", "viper",
  "bee", "ant", "beetle", "butterfly", "dragonfly", "firefly", "moth", "cricket",
  "salmon", "trout", "pike", "carp", "bass", "tuna", "marlin", "anchovy",
];

function generateRoomCode() {
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = animals[Math.floor(Math.random() * animals.length)];
  const num = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${a}-${n}-${num}`;
}

module.exports = { generateRoomCode };
