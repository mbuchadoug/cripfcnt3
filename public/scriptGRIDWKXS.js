const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("message");
const statusEl = document.getElementById("status");

async function send() {
  const message = inputEl.value.trim();
  if (!message) return;

  appendMessage("user", message);
  inputEl.value = "";
  statusEl.textContent = "AI is typing...";

  const response = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function typeWriter(text, el, speed = 10) {
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        el.innerHTML += text.charAt(i);
        i++;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        clearInterval(interval);
      }
    }, speed);
  }

  let aiMessageEl = appendMessage("ai", "");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop(); // keep unfinished chunk

    for (let part of parts) {
      if (part.startsWith("data: ")) {
        const content = part.replace("data: ", "").trim();
        if (content === "[DONE]" || content === "[WAITING_FOR_QUALITATIVE_INPUT]") {
          statusEl.textContent = "";
          continue;
        }
        typeWriter(content + "\n", aiMessageEl, 15);
      }
    }
  }

  statusEl.textContent = "";
}

function appendMessage(type, text) {
  const msg = document.createElement("div");
  msg.className = type;
  msg.innerHTML = text;
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return msg;
}

inputEl.addEventListener("keypress", (e) => {
  if (e.key === "Enter") send();
});
