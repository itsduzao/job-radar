import { describe, expect, it, vi } from "vitest";
import { HttpTelegramClient, sendDigest } from "../src/telegram.js";
import type { TelegramClient } from "../src/telegram.js";
import type { Vaga } from "../src/domain.js";

const runDate = new Date("2026-10-07T12:00:00Z");

const vaga: Vaga = {
  role: "Estágio Backend",
  empresa: "Acme",
  link: "https://example.com/post/1",
  localizacao: "Florianópolis/SC",
  tipo: "estagio",
  area: "backend",
  modalidade: "remoto",
};

function fakeClient() {
  const sendMessage = vi.fn();
  return { client: { sendMessage } as TelegramClient, sendMessage };
}

describe("sendDigest", () => {
  it("não envia quando não há vagas", async () => {
    const { client, sendMessage } = fakeClient();
    await sendDigest([], client, runDate);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("envia a mensagem formatada quando há vagas", async () => {
    const { client, sendMessage } = fakeClient();
    await sendDigest([vaga], client, runDate);
    expect(sendMessage).toHaveBeenCalledWith(
      "1 vaga nova (run de 2026-10-07)\n" +
        "Estágio Backend · Acme · Florianópolis/SC · https://example.com/post/1",
    );
  });
});

describe("HttpTelegramClient", () => {
  it("envia a mensagem via API do Telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new HttpTelegramClient("token", "chat");
      await client.sendMessage("olá");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.telegram.org/bottoken/sendMessage",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: "chat", text: "olá" }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lança erro quando a API responde com falha", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    try {
      const client = new HttpTelegramClient("token", "chat");
      await expect(client.sendMessage("olá")).rejects.toThrow("401");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
