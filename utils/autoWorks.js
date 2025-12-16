// utils/autoFetchAndScore.js
import { TavilyClient } from "tavily";

/**
 * Initialize Tavily client with API key
 */
const tavily = new TavilyClient({
  apiKey: process.env.TAVILY_API_KEY || "your_tavily_key_here",
});

/**
 * Auto-fetch and score information using Tavily (and OpenAI fallback)
 * @param {string} query - What to search for
 * @param {object} openai - OpenAI client instance
 * @returns {Promise<object>} - Summary and scored results
 */
export default async function autoFetchAndScore(query, openai) {
  console.log("🔍 [autoFetchAndScore] Searching for:", query);

  let tavilyResults = null;

  try {
    // 🧭 Try fetching from Tavily
    tavilyResults = await tavily.search({
      query,
      search_depth: "advanced",
      max_results: 5,
    });
  } catch (error) {
    console.error("❌ Tavily fetch failed:", error.message);
  }

  // If Tavily gave no usable results
  if (!tavilyResults || !tavilyResults.results || tavilyResults.results.length === 0) {
    console.warn("⚠️ Tavily returned no results, using OpenAI fallback...");

    // Use OpenAI to simulate a web summary fallback
    const fallback = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `You are a web assistant. Summarize what you know about "${query}" from current web knowledge.`,
    });

    const summary = fallback.output?.[0]?.content?.[0]?.text || "No summary available.";
    return {
      source: "openai-fallback",
      summary,
      results: [],
    };
  }

  // Combine Tavily results for context
  const combinedText = tavilyResults.results
    .map((r) => `${r.title}\n${r.snippet}`)
    .join("\n\n");

  // Ask OpenAI to evaluate and summarize
  const aiSummary = await openai.responses.create({
    model: "gpt-4o-mini",
    input: `
      Here are web search results about "${query}":
      ${combinedText}
      
      Summarize the main points in 5 bullet points.
      Then rate relevance (0–10) for how useful these are to someone asking about "${query}".
    `,
  });

  const summaryText = aiSummary.output?.[0]?.content?.[0]?.text || "Summary not available.";

  // Return structured results
  return {
    source: "tavily",
    summary: summaryText,
    results: tavilyResults.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    })),
  };
}
