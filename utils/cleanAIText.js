/**
 * cleanAIText.js
 * Simple text cleaner to normalize AI output.
 */

export function cleanAIText(text) {
  if (!text || typeof text !== "string") return "";

  return text
    .replace(/\*\*/g, "")                // remove markdown bold
    .replace(/#+\s?/g, "")               // remove markdown headers
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")  // remove markdown links
    .replace(/\n{3,}/g, "\n\n")          // collapse excessive line breaks
    .replace(/\r/g, "")                  // remove carriage returns
    .replace(/\t/g, " ")                 // remove tabs
    .replace(/[“”]/g, '"')               // normalize quotes
    .replace(/[‘’]/g, "'")               // normalize apostrophes
    .trim();
}
