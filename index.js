import WebSocket from "ws";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import "dotenv/config";

/* ----------  0. email helper  ---------- */
const smtp = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SENDER_EMAIL,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});
const receiverEmails = process.env.RECEIVER_EMAIL
  ? process.env.RECEIVER_EMAIL.split(",").map(e => e.trim()).filter(Boolean)
  : [];

async function sendMail(ticker) {
  await smtp.sendMail({
    from: process.env.SENDER_EMAIL,
    to: receiverEmails,
    subject: `🔥 New WSB trending ticker: ${ticker}`,
    text: `${ticker} just appeared in WSBApp's daily trending list.`,
  });
  console.log("  ↳ email sent");
}

/* ----------  1. OAuth refresh  ---------- */
async function getAccessToken() {
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    throw new Error(`token refresh failed ${res.status}`);
  }
  const { access_token, expires_in } = await res.json();
  return { access_token, expires_in };
}

/* ----------  2. open socket & stream  ---------- */
const headers = {
  Origin: "https://www.reddit.com",
  // cookies optional for this feed; leave them if you like:
  Cookie: `reddit_session=${process.env.REDDIT_SESSION}; loid=${process.env.LOID}`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/118.0 Safari/537.36",
};

const announced = new Set();

async function start() {
  const { access_token, expires_in } = await getAccessToken();

  const ws = new WebSocket(
    "wss://gql-realtime.reddit.com/query",
    "graphql-transport-ws",
    { headers }
  );

  /* refresh again 1 min before expiry */
  const refreshTimer = setTimeout(() => {
    console.log("⟳ token refresh");
    ws.close();
  }, (expires_in - 60) * 1_000);

  ws.on("open", () => {
    console.log("socket open");
    ws.send(
      JSON.stringify({
        type: "connection_init",
        payload: { Authorization: `Bearer ${access_token}` },
      })
    );
  });

  ws.on("message", async (raw) => {
    const m = JSON.parse(raw);

    /* respond to heartbeat */
    if (m.type === "ping") {
      console.log("received ping, sending pong");
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    /* wait for server ack, then subscribe once */
    if (m.type === "connection_ack") {
      ws.send(
        JSON.stringify({
          id: "1",
          type: "subscribe",
          payload: {
            operationName: "SubscribeSubscription",
            query: `
              subscription SubscribeSubscription($input: SubscribeInput!) {
                subscribe(input: $input) {
                  id
                  ... on BasicMessage {
                    data { ... on DevPlatformAppMessageData { payload } }
                  }
                }
              }`,
            variables: {
              input: {
                channel: {
                  teamOwner: "DEV_PLATFORM",
                  category: "DEV_PLATFORM_APP_EVENTS",
                  tag: "wsbapp:771348a3-fe17-45f7-9e5d-4741f9b38b5b:LIVE_FEED",
                },
              },
            },
          },
        })
      );
      return;
    }

    if (m.type !== "next") return;

    const inner = JSON.parse(m.payload.data.subscribe.data.payload.msg);
    let someNew = false;
    for (const tkr of inner.data.appData.trendingTickersDaily) {
      if (!announced.has(tkr)) {
        announced.add(tkr);
        console.log("NEW:", tkr);
        try {
          await sendMail(tkr);
        } catch (e) {
          console.error("email error:", e.message);
        }
      }
    }
    if (!someNew) {
      console.log("no new tickers");
    }
  });

  ws.on("close", (code) => {
    clearTimeout(refreshTimer);
    console.log("socket closed", code, "– reconnecting in 5 s");
    setTimeout(start, 5_000);
  });
  ws.on("error", console.error);
}

start();
