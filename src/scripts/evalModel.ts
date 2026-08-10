import { config } from "../config/env.js";
import { createLlmClient } from "../services/llm.js";
import { extractIntent, type IntentName } from "../services/intent.js";

/**
 * Measures how well the configured model handles intent extraction.
 *
 * Every user brings a different model, so "is a 3B good enough?" can't be
 * answered once in a doc — it has to be measured against whatever they have.
 * Run with: pnpm eval:model
 */

interface Case {
    message: string;
    expect: IntentName;
    /**
     * The marker history this message would realistically arrive with.
     * Context-dependent phrases ("yes please", "make that 3") are meaningless
     * without it, so grading them against an empty history measures nothing.
     */
    history?: string[];
    /** Optional extra assertions on the extracted fields. */
    check?: (intent: Record<string, unknown>) => boolean;
}

const AFTER_SEARCH = ["user: do you have any mugs?", "assistant: search"];
const AFTER_ASK = ["user: add a mug", "assistant: asked_confirmation"];
const AFTER_ADD = ["user: add a mug", "assistant: confirmed"];

const CASES: Case[] = [
    { message: "do you have any mugs?", expect: "search" },
    { message: "anything under 20 quid?", expect: "search", check: (i) => i["max_price"] === 20 },
    { message: "show me headphones", expect: "search" },
    { message: "how much is the classic tee?", expect: "product_detail" },
    { message: "tell me more about it", expect: "product_detail", history: AFTER_SEARCH },
    { message: "add a ceramic mug to my cart", expect: "add_to_cart" },
    {
        message: "I'll take two of those",
        expect: "add_to_cart",
        history: AFTER_SEARCH,
        check: (i) => i["quantity"] === 2,
    },
    {
        message: "yes please",
        expect: "confirm",
        history: AFTER_ASK,
        check: (i) => i["affirmative"] === true,
    },
    {
        message: "no thanks",
        expect: "confirm",
        history: AFTER_ASK,
        check: (i) => i["affirmative"] === false,
    },
    {
        message: "make that 3",
        expect: "set_quantity",
        history: AFTER_ADD,
        check: (i) => i["quantity"] === 3,
    },
    { message: "what's in my basket?", expect: "view_cart" },
    { message: "remove the tee from my cart", expect: "set_quantity" },
    {
        message: "where is my order b71f0562-a143-4207-a8ba-5e46a6925787",
        expect: "lookup_order",
    },
    { message: "hello there", expect: "smalltalk" },
    { message: "what is the airspeed velocity of an unladen swallow", expect: "unknown" },
];

/** Below this the assistant will feel broken; suggest a larger model. */
const PASS_THRESHOLD = 0.7;

async function main(): Promise<void> {
    const llm = createLlmClient({
        baseUrl: config.LLM_BASE_URL,
        model: config.LLM_MODEL,
        apiKey: config.LLM_API_KEY,
        timeoutMs: config.LLM_TIMEOUT_MS,
    });

    console.log(`Endpoint: ${config.LLM_BASE_URL}`);
    console.log(`Model:    ${config.LLM_MODEL}\n`);

    if (!(await llm.isReachable())) {
        console.error(`No model endpoint answering at ${config.LLM_BASE_URL}.`);
        console.error(`Start one with:  ollama serve`);
        console.error(`Then:            ollama pull ${config.LLM_MODEL}`);
        process.exitCode = 1;
        return;
    }

    let correct = 0;
    let fieldsCorrect = 0;
    let fieldsChecked = 0;
    const started = Date.now();

    let timedOut = 0;

    for (const testCase of CASES) {
        const turnStarted = Date.now();

        let intent;
        try {
            intent = await extractIntent(llm, testCase.history ?? [], testCase.message);
        } catch (err) {
            // A timeout usually means the model is too large for this machine
            // and is swapping. Report it as a result, not a crash.
            timedOut += 1;
            const seconds = ((Date.now() - turnStarted) / 1000).toFixed(0);
            console.log(`FAIL  ${seconds.padStart(5)}s   ${testCase.message}`);
            console.log(`        → ${(err as Error).message}`);
            continue;
        }

        const ms = Date.now() - turnStarted;

        const intentOk = intent.intent === testCase.expect;
        if (intentOk) correct += 1;

        let fieldNote = "";
        if (testCase.check !== undefined) {
            fieldsChecked += 1;
            const fieldOk = testCase.check(intent as unknown as Record<string, unknown>);
            if (fieldOk) fieldsCorrect += 1;
            fieldNote = fieldOk ? "" : "  (fields off)";
        }

        const mark = intentOk ? "PASS" : "FAIL";
        const got = intentOk ? intent.intent : `${intent.intent} — wanted ${testCase.expect}`;
        console.log(
            `${mark}  ${String(ms).padStart(5)}ms  ${testCase.message}\n        → ${got}${fieldNote}`
        );
    }

    const accuracy = correct / CASES.length;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\nIntent accuracy: ${correct}/${CASES.length} (${Math.round(accuracy * 100)}%)`);
    if (fieldsChecked > 0) {
        console.log(`Field accuracy:  ${fieldsCorrect}/${fieldsChecked}`);
    }
    console.log(`Total time:      ${seconds}s for ${CASES.length} turns`);

    if (timedOut > 0) {
        console.log(
            `\n${timedOut} turn(s) timed out after ${config.LLM_TIMEOUT_MS}ms. A model that's too`
        );
        console.log(`large for the available RAM will swap and crawl — try a smaller one.`);
    }

    if (accuracy < PASS_THRESHOLD) {
        console.log(
            `\nBelow ${Math.round(PASS_THRESHOLD * 100)}% — the assistant will misread a lot of messages.`
        );
        console.log(`Try a larger model, or one tuned for instruction following.`);
        process.exitCode = 1;
    }
}

await main();
