const greeting = [
  /^(?:hi|hello|hey|howdy|yo|sup)(?:\s+(?:there|jarvis|bro|man|dude|my\s+(?:friend|guy|man|dude|bro)|buddy))?[!.,]?(?:\s+.*)?$/i,
  /^what(?:'?s|\s+is)\s+up(?:\s+.*)?$/i,
];
const smartHome = [
  /^turn\s+(on|off)\s+(?:the\s+)?(.+)$/i,
  /^switch\s+(on|off)\s+(?:the\s+)?(.+)$/i,
  /^(on|off)\s+(?:the\s+)?(.+)$/i,
  /^dim\s+(?:the\s+)?(.+?)(?:\s+to\s+(\d+))?$/i,
  /^lights?\s+(on|off|dim)$/i,
  /^(on|off)\s+lights?$/i,
  /^smart\s+home\s+(.+)$/i,
];

const inputs = [
  "hey can you kill the lights",
  "hey can you turn the lights off",
  "hey turn off the lights",
  "turn the lights off",
  "kill the lights",
  "turn off the lights",
  "hey jarvis",
  "hey jarvis turn off the lights",
];

for (const input of inputs) {
  const g = greeting.some(r => r.test(input));
  const shMatch = smartHome.find(r => r.test(input));
  console.log(JSON.stringify(input));
  console.log("  greeting match:", g);
  console.log("  smart-home match:", shMatch ? shMatch.toString() : "NONE");
}
