import { formatDigest } from "./digest.js";
import type { Vaga } from "./domain.js";

export interface TelegramClient {
  sendMessage(text: string): Promise<void>;
}

export class HttpTelegramClient implements TelegramClient {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  async sendMessage(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed with status ${res.status}`);
    }
  }
}

export async function sendDigest(
  vagas: Vaga[],
  client: TelegramClient,
  runDate: Date,
): Promise<void> {
  if (vagas.length === 0) {
    return;
  }
  await client.sendMessage(formatDigest(vagas, runDate));
}
