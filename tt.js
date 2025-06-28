import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import ejs from "ejs";
import { pipeline as __initCognitiveSummarizer__ } from "@xenova/transformers";


const CognitiveBuffer = new Map();
const Registry = new Map();
const SummaryFabric = Symbol("SummaryFabric");


let SummarizerNode;
(async function bootstrapNeuroCore() {
    SummarizerNode = await __initCognitiveSummarizer__("summarization", "Xenova/t5-small");
})();


const TransitLayer = (() => {
    const app = express();
    app.set("view engine", "ejs");
    app.use(express.static("public"));
    app.use(express.urlencoded({ extended: true }));
    return app;
})();


const RepetitionEvictor = (() => {
    const MAX_OCCURRENCE = 5;
    return Object.freeze(function (rawText) {
        const lex = rawText.split(/\s+/);
        const cache = {};
        return lex.filter(word => {
            const k = word.toLowerCase();
            cache[k] = (cache[k] || 0) + 1;
            return cache[k] <= MAX_OCCURRENCE;
        }).join(" ");
    });
})();


function DuckDuckGoOperator(query) {
    if (CognitiveBuffer.has(query)) return Promise.resolve(CognitiveBuffer.get(query));
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    return axios.get(searchUrl, {
        headers: { "User-Agent": "LLM-Agent/9.9.1 (Warp Protocol)" }
    }).then(response => {
        const $ = cheerio.load(response.data);
        const results = [];

        const avoidDupes = new Set();
        $(".result__title a").each((_, el) => {
            const encoded = $(el).attr("href");
            const decoded = decodeURIComponent((encoded.match(/uddg=([^&]*)/) || [])[1] || "");
            if (decoded.startsWith("http") && !decoded.includes("duckduckgo.com")) {
                const host = new URL(decoded).hostname;
                if (!avoidDupes.has(host)) {
                    avoidDupes.add(host);
                    results.push({ title: $(el).text().trim(), url: decoded });
                }
            }
        });

        const final = results.slice(0, 10);
        CognitiveBuffer.set(query, final);
        return final;
    }).catch(() => []);
}


const RelevanceMatrix = new (class {
    async extract(url, query) {
        try {
            const headers = { "User-Agent": "Mozilla/5.0 (NeuralMeshCrawler)" };
            await axios.head(url, { headers, timeout: 2000 });
            const { data } = await axios.get(url, { headers, timeout: 4000 });
            const $ = cheerio.load(data);

            $("style, script, nav, footer, noscript, .ads, .popup, audio, video, button").remove();
            const keywordRegex = new RegExp(`\\b${query}\\b`, "i");

            const chunks = $("article, main, p, h1, h2, h3")
                .map((_, el) => $(el).text().trim())
                .get()
                .filter(txt => txt.length > 50 && keywordRegex.test(txt));

            return chunks.length
                ? RepetitionEvictor([...new Set(chunks)].join(" ").slice(0, 3000))
                : null;
        } catch {
            return null;
        }
    }
})();


const SummarizationProxy = new Proxy({}, {
    get: () => async function (text) {
        const clean = RepetitionEvictor(text);
        try {
            const output = await SummarizerNode(clean, { max_length: 150, min_length: 60 });
            return output[0].summary_text;
        } catch {
            return clean.split(".").slice(0, 3).join(". ") + ".";
        }
    }
});


async function SummarizationLoop(query) {
    const sources = await DuckDuckGoOperator(query);
    const buffer = [];
    const visited = new Set();

    for (const { title, url } of sources) {
        if (buffer.length >= 5) break;
        const host = new URL(url).hostname;
        if (visited.has(host)) continue;

        const raw = await RelevanceMatrix.extract(url, query);
        if (!raw) continue;

        const summary = await SummarizationProxy.default(raw);
        buffer.push({ title, url, summary });
        visited.add(host);
    }

    return buffer;
}


TransitLayer.get("/", (_, res) => {
    res.render("index", { summary: null, query: null, finalSummary: null });
});
TransitLayer.get("/legal", (_, res) => {
    res.render("legal");
});
TransitLayer.post("/search", async (req, res) => {
    const query = req.body.query;

    if (CognitiveBuffer.has(`summary-${query}`)) {
        return res.render("index", CognitiveBuffer.get(`summary-${query}`));
    }

    const summaryPayload = await SummarizationLoop(query);
    const finalSummary = summaryPayload.length
        ? await SummarizationProxy.default(summaryPayload.map(s => s.summary).join(" "))
        : "Void: no intelligence detected.";

    const output = { summary: summaryPayload, query, finalSummary };
    CognitiveBuffer.set(`summary-${query}`, output);

    res.render("index", output);
});

TransitLayer.listen(3000, () =>
    console.log("Online at http://localhost:3000")
);
