const topics = { delivery: "Доставка", pricing: "Стоимость", other: "Другое" };
const manualMessage = "Нужен ручной разбор: автоматический ответ недоступен. Прочитайте заявку и подготовьте ответ самостоятельно.";

export function mountTriage(document, fetcher = globalThis.fetch) {
  const form = document.querySelector("form");
  const message = document.querySelector("#message");
  const status = document.querySelector("#status");
  const topic = document.querySelector("#topic");
  const draft = document.querySelector("#draft");
  let latest = 0;
  let active;
  const clear = () => { topic.textContent = ""; draft.textContent = ""; };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = ++latest;
    active?.abort();
    clear();
    const text = message.value.trim();
    if (!text) {
      status.textContent = "Введите текст заявки.";
      return;
    }
    const controller = new AbortController();
    active = controller;
    status.textContent = "Разбираем заявку…";
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Request deadline exceeded"));
          controller.abort();
        }, 5000);
      });
      const data = await Promise.race([
        (async () => {
          const reply = await fetcher("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          });
          if (!reply.ok) throw new Error("Request failed");
          return reply.json();
        })(),
        deadline,
      ]);
      if (current !== latest) return;
      if (!data || data.status !== "ready" || !Object.hasOwn(topics, data.topic) ||
          typeof data.draft !== "string" || !data.draft.trim()) {
        throw new Error("Manual review required");
      }
      topic.textContent = `Тема: ${topics[data.topic]}`;
      draft.textContent = data.draft.trim();
      status.textContent = "Черновик готов. Проверьте его перед отправкой клиенту.";
    } catch {
      if (current !== latest) return;
      clear();
      status.textContent = manualMessage;
    } finally {
      clearTimeout(timer);
    }
  });
}

if (typeof document !== "undefined") mountTriage(document);
