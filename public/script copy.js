const messagesDiv = document.getElementById("messages");
const input = document.getElementById("message");
const statusDiv = document.getElementById("status");

function appendMessage(text, type = "ai") {
  const div = document.createElement("div");
  div.className = type;
  div.textContent = text;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

async function send() {
  const message = input.value.trim();
  if (!message) return;

  appendMessage(message, "user");
  input.value = "";
  statusDiv.textContent = "AI is typing...";

  const response = await fetch("/api/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.body) {
    statusDiv.textContent = "Error: no response from server";
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let aiText = "";

  while (!done) {
    const { value, done: doneReading } = await reader.read();
    done = doneReading;
    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n\n").filter(Boolean);

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const text = line.replace("data: ", "").trim();
          if (text === "[DONE]") {
            statusDiv.textContent = "";
            appendMessage(aiText, "ai");
            aiText = "";
          } else if (text === "[WAITING_FOR_QUALITATIVE_INPUT]") {
            statusDiv.textContent = "Awaiting qualitative input from client...";
          } else {
            aiText += text + "\n";
          }
        }
      }
    }
  }
}
