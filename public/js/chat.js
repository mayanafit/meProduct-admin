/**
 * Shop assistant widget.
 *
 * Deliberately dependency-free and non-streaming: one POST per turn, with a
 * typing indicator covering the wait. Local models take a couple of seconds.
 */
(function () {
    "use strict";

    var panel = document.getElementById("chat-panel");
    var log = document.getElementById("chat-log");
    var form = document.getElementById("chat-form");
    var input = document.getElementById("chat-input");
    var send = document.getElementById("chat-send");
    var status = document.getElementById("chat-status");
    var launcher = document.getElementById("chat-launcher");
    var close = document.getElementById("chat-close");

    if (!panel || !form || !input || !log) return;

    var statusChecked = false;

    function bubble(text, who) {
        var wrap = document.createElement("div");
        wrap.className = who === "user" ? "flex justify-end" : "flex justify-start";

        var el = document.createElement("p");
        el.className =
            who === "user"
                ? "max-w-[85%] whitespace-pre-line rounded-lg bg-slate-900 px-3 py-2 text-white"
                : "max-w-[85%] whitespace-pre-line rounded-lg bg-slate-100 px-3 py-2 text-slate-800";
        // textContent, never innerHTML: replies quote product descriptions,
        // which are operator-authored text we must not execute as markup.
        el.textContent = text;

        wrap.appendChild(el);
        log.appendChild(wrap);
        log.scrollTop = log.scrollHeight;
        return wrap;
    }

    function setBusy(busy) {
        send.disabled = busy;
        input.disabled = busy;
    }

    function updateCartBadge(count) {
        var badge = document.querySelector("[data-testid='cart-count']");
        if (!badge || typeof count !== "number") return;

        badge.textContent = String(count);
        badge.className =
            "rounded-full px-2 py-0.5 text-xs font-semibold " +
            (count > 0 ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500");
    }

    function checkStatus() {
        if (statusChecked) return;
        statusChecked = true;

        fetch("/chat/status")
            .then(function (res) {
                return res.json();
            })
            .then(function (body) {
                status.textContent = body.available ? "Ready" : "No model running";
                if (!body.available) {
                    bubble(
                        "I can't reach a language model right now. Start one with \"ollama serve\", then pull a model with \"ollama pull qwen3:4b\".",
                        "assistant"
                    );
                }
            })
            .catch(function () {
                status.textContent = "Unavailable";
            });
    }

    function open() {
        panel.hidden = false;
        launcher.hidden = true;
        input.focus();
        checkStatus();
    }

    function hide() {
        panel.hidden = true;
        launcher.hidden = false;
    }

    launcher.addEventListener("click", open);
    if (close) close.addEventListener("click", hide);

    form.addEventListener("submit", function (event) {
        event.preventDefault();

        var message = input.value.trim();
        if (message === "") return;

        bubble(message, "user");
        input.value = "";
        setBusy(true);

        var thinking = bubble("…", "assistant");

        fetch("/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: message }),
        })
            .then(function (res) {
                return res.json().then(function (body) {
                    return { ok: res.ok, body: body };
                });
            })
            .then(function (result) {
                thinking.remove();
                bubble(result.body.reply || "Something went wrong.", "assistant");
                updateCartBadge(result.body.cartCount);

                if (result.body.modelAvailable === false) status.textContent = "No model running";
            })
            .catch(function () {
                thinking.remove();
                bubble("I couldn't reach the shop just then. Try again?", "assistant");
            })
            .finally(function () {
                setBusy(false);
                input.focus();
            });
    });
})();
