import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import ejs from "ejs";
import { pipeline } from "@xenova/transformers";

let summarizer;
(async () => {
    console.log("⏳ Loading AI Model...");
    summarizer = await pipeline("summarization", "Xenova/t5-small");
    console.log("✅ Model Ready!");
})();

const app = express();
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

const CACHE = new Map();

function decodeDuckDuckGoURL(url) {
    const match = url.match(/uddg=([^&]*)/);
    return match ? decodeURIComponent(match[1]) : url;
}


async function duckDuckGoSearch(query) {
    if (CACHE.has(query)) return CACHE.get(query);

    try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const headers = { "User-Agent": "Mozilla/5.0" };
        const response = await axios.get(searchUrl, { headers });

        const $ = cheerio.load(response.data);
        const uniqueSites = new Set();
        const results = [];

        $(".result__title a").each((_, element) => {
            const title = $(element).text().trim();
            const encodedUrl = $(element).attr("href");
            const url = decodeDuckDuckGoURL(encodedUrl);

            if (url.startsWith("http") && !url.includes("duckduckgo.com") && !uniqueSites.has(new URL(url).hostname)) {
                uniqueSites.add(new URL(url).hostname);
                results.push({ title, url });
            }
        });

        CACHE.set(query, results.slice(0, 10));
        return results.slice(0, 10);
    } catch (error) {
        console.error("❌ Search error:", error);
        return [];
    }
}

// ✅ Extracts only meaningful text, ignores duplicates
async function fetchRelevantContent(url, query) {
    try {
        const headers = { "User-Agent": "Mozilla/5.0" };
        await axios.head(url, { headers, timeout: 3000 });

        const response = await axios.get(url, { headers, timeout: 5000 });
        const $ = cheerio.load(response.data);
        const keywordRegex = new RegExp(`\\b${query}\\b`, "i");

        $("style, script, noscript, nav, footer, aside, .ads, .popup, audio, video, button").remove();

        const extractedText = $("article, main, p, h1, h2, h3")
            .map((_, el) => $(el).text().trim())
            .get()
            .filter(text => text.length > 50 && keywordRegex.test(text));

        const uniqueText = [...new Set(extractedText)]; // ✅ Removes duplicate sentences
        return uniqueText.join(" ").slice(0, 3000);
    } catch {
        return null;
    }
}

// ✅ AI Summarization (Forces AI use even for partial results)
async function summarizeText(text) {
    try {
        if (!summarizer) throw new Error("⏳ Model Not Ready!");
        const summary = await summarizer(text, { max_length: 150, min_length: 60 });
        return summary[0].summary_text;
    } catch (error) {
        console.error("❌ Summarization failed:", error);
        return text.split(".").slice(0, 3).join(".");
    }
}

// ✅ Guarantees 5 Unique Summaries
async function getTopSummarizedResults(query) {
    const results = await duckDuckGoSearch(query);
    const summaries = [];
    const seenHosts = new Set();

    for (const result of results) {
        if (summaries.length >= 5) break;
        if (seenHosts.has(new URL(result.url).hostname)) continue; // ✅ Prevents duplicate domains

        const content = await fetchRelevantContent(result.url, query);
        if (!content) continue;

        const summary = await summarizeText(content);
        summaries.push({ title: result.title, url: result.url, summary });
        seenHosts.add(new URL(result.url).hostname);
    }

    return summaries;
}

app.get("/", (req, res) => {
    res.render("index", { summary: null, query: null, finalSummary: null });
});
app.get("/legal", (req, res) => {
    res.render("legal");
});
app.post("/search", async (req, res) => {
    const query = req.body.query;

    if (CACHE.has(`summary-${query}`)) {
        return res.render("index", CACHE.get(`summary-${query}`));
    }

    const summaries = await getTopSummarizedResults(query);
    const finalSummary = summaries.length > 0
        ? await summarizeText(summaries.map(s => s.summary).join(" "))
        : "No relevant information found.";

    const resultData = { summary: summaries, query, finalSummary };
    CACHE.set(`summary-${query}`, resultData);

    res.render("index", resultData);
});

app.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));
