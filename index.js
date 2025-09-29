require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const ping = new Map();
const aiSessions = new Map(); // userId -> { chatId, characterId, timeout }

const CAI_CONFIG = {
  token: process.env.CAI_TOKEN,
  characterId: process.env.CAI_CHARACTER_ID || "oGuQaiFfi-fwZiwBbw8BBY7edbkhuON6zIRWv_6MOA0", // From analytics
  baseUrl: "https://character.ai",
  neoUrl: "https://neo.character.ai"
};

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const wsConnections = new Map();
const pendingResponses = new Map();

async function createCharacterAIWebSocket(userId) {
  try {
    const ws = new WebSocket("wss://neo.character.ai/ws/", {
      headers: {
        "Origin": "https://character.ai",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Authorization": `Token ${CAI_CONFIG.token}`, 
      }
    });

    return new Promise((resolve, reject) => {
      ws.on("open", () => {
        console.log(`ws connected for ${userId}`);
        wsConnections.set(userId, ws);
        resolve(ws);
      });

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          handleWebSocketMessage(userId, message);
        } catch (error) {
          console.error("error parsing ws, wth??? ", error);
        }
      });

      ws.on("error", (error) => {
        console.error("ws error:", error);
        wsConnections.delete(userId);
        reject(error);
      });

      ws.on("close", () => {
        console.log(`ws closed for ${userId}`);
        wsConnections.delete(userId);
      });
    });

  } catch (error) {
    console.error("error generating ws: ", error);
    return null;
  }
}

// handle c.ai ws
function handleWebSocketMessage(userId, message) {
  console.log("ws message:", message.command || message.error || "unknown", message.request_id);

  if (message.command === "neo_error" || message.error) {
    console.error("c.ai error: ", message);
    const callback = pendingResponses.get(message.request_id);
    if (callback) {
      callback("auth token may have expired. issue when connecting to c.ai or issue with c.ai in general...");
      pendingResponses.delete(message.request_id);
    }
    return;
  }

  if (message.command === "create_chat_response") {
    console.log("chat generated");
    const callback = pendingResponses.get(message.request_id);
    if (callback) {
      callback();
      pendingResponses.delete(message.request_id);
    }
    return;
  }

  // final ai response
  if (message.command === "update_turn" && message.turn.candidates[0].is_final) {
    const characterResponse = message.turn.candidates[0].raw_content;
    const requestId = message.request_id;
    
    console.log("final ai response: ", characterResponse);
    
    const callback = pendingResponses.get(requestId);
    if (callback) {
      callback(characterResponse);
      pendingResponses.delete(requestId);
    }
  }
}

async function createNewChat(userId, characterId) {
  try {
    let ws = wsConnections.get(userId);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = await createCharacterAIWebSocket(userId);
      if (!ws) {
        throw new Error("failed to connect to ws connections");
      }
    }

    const requestId = uuidv4();
    const chatId = uuidv4();

    const createChatPayload = {
      command: "create_chat",
      request_id: requestId,
      payload: {
        chat: {
          chat_id: chatId,
          creator_id: "534643361",
          visibility: "VISIBILITY_PRIVATE",
          character_id: characterId,
          type: "TYPE_ONE_ON_ONE"
        }
      },
      origin_id: "web-next"
    };

    ws.send(JSON.stringify(createChatPayload));

    return new Promise((resolve, reject) => {
      pendingResponses.set(requestId, () => {
        resolve(chatId);
      });
      
      setTimeout(() => {
        if (pendingResponses.has(requestId)) {
          pendingResponses.delete(requestId);
          reject(new Error("chat generation timeout"));
        }
      }, 10000);
    });

  } catch (error) {
    console.error("error when generating new chat:", error);
    return null;
  }
}

async function sendMessageViaWebSocket(userId, messageText, characterId, chatId) {
  try {
    let ws = wsConnections.get(userId);


    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = await createCharacterAIWebSocket(userId);
      if (!ws) {
        throw new Error("failed to connect with ws connections");
      }
    }

    if (!chatId) {
      console.log("generating new chat... ... ... ");
      chatId = await createNewChat(userId, characterId);
      if (!chatId) {
        throw new Error("failed new chat");
      }
      console.log("new chat at ", chatId);
      
      const session = aiSessions.get(userId);
      if (session) {
        session.chatId = chatId;
      }
    }

    const requestId = uuidv4();
    const turnId = uuidv4();
    const candidateId = uuidv4();

    const messagePayload = {
      command: "create_and_generate_turn",
      request_id: requestId,
      payload: {
        chat_type: "TYPE_ONE_ON_ONE",
        num_candidates: 1,
        tts_enabled: false,
        selected_language: "",
        character_id: characterId,
        user_name: "memo",
        turn: {
          turn_key: {
            turn_id: turnId,
            chat_id: chatId
          },
          author: {
            author_id: "534643361",
            is_human: true,
            name: "memo",
            avatar_url: "uploaded/2024/9/30/bg1lcb9D_Hfoz-sU3D-rU1_WnULsymApi4VsD9PJpbQ.webp" // Your avatar
          },
          candidates: [{
            candidate_id: candidateId,
            raw_content: messageText
          }],
          primary_candidate_id: candidateId
        },
        previous_annotations: {
          boring: 0, not_boring: 0, inaccurate: 0, not_inaccurate: 0,
          repetitive: 0, not_repetitive: 0, out_of_character: 0, not_out_of_character: 0,
          bad_memory: 0, not_bad_memory: 0, long: 0, not_long: 0,
          short: 0, not_short: 0, ends_chat_early: 0, not_ends_chat_early: 0,
          funny: 0, not_funny: 0, interesting: 0, not_interesting: 0,
          helpful: 0, not_helpful: 0
        },
        generate_comparison: false
      },
      origin_id: "web-next"
    };

    ws.send(JSON.stringify(messagePayload));

    return new Promise((resolve, reject) => {
      pendingResponses.set(requestId, resolve);
      
      setTimeout(() => {
        if (pendingResponses.has(requestId)) {
          pendingResponses.delete(requestId);
          console.error("ignored message or response timed out");;
        }
      }, 30000);
    });

  } catch (error) {
    console.error("error sending msg with websocket: ", error);;
  }
}

async function sendMessageToCharacter(message, userId) {
  try {
    const session = aiSessions.get(userId);
    if (!session) {
    }
    
    const characterId = CAI_CONFIG.characterId;
    const chatId = session.chatId;
    
    console.log(`sending to c.ai: "${message}"`);
    
    const response = await sendMessageViaWebSocket(userId, message, characterId, chatId);
    
    return response;
    
  } catch (error) {
    console.error("error when communicating with c.ai: ", error);
  }
}

function startAISession(userId) {
  // clear ws and timeout
  const existingSession = aiSessions.get(userId);
  if (existingSession?.timeout) {
    clearTimeout(existingSession.timeout);
  }
  
  // close ws
  const existingWS = wsConnections.get(userId);
  if (existingWS && existingWS.readyState === WebSocket.OPEN) {
    existingWS.close();
  }

  // new session
  const session = {
    chatId: null,
    characterId: CAI_CONFIG.characterId,
    discordUserId: userId,
    timeout: null
  };

  aiSessions.set(userId, session);
  console.log(`user ${userId} is using ai`);
  console.log(`using : ${session.characterId} in c.ai`);
}

function refreshAISession(userId) {
  const session = aiSessions.get(userId);
  if (!session) return false;

  // clear timeout
  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  // set new timeout
  session.timeout = setTimeout(() => {
    endAISession(userId);
  }, 30000);

  return true;
}

function endAISession(userId) {
  const session = aiSessions.get(userId);
  if (session?.timeout) {
    clearTimeout(session.timeout);
  }
  
  // close ws
  const ws = wsConnections.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  wsConnections.delete(userId);
  
  aiSessions.delete(userId);
  console.log(`ai exited for ${userId}`);
}

function isInAIMode(userId) {
  return aiSessions.has(userId);
}



client.once("ready", () => {
  console.log(`${client.user.tag}`);
  console.log(`c.ai ${CAI_CONFIG.token ? "enabled" : "disabled"}`);
});

client.on("messageCreate", async message => {
  // ignore messages from bots
  if (message.author.bot) return;

  // normalize
  const content = message.content.trim().toLowerCase();
  const user = message.author.id;

  // check if user is using ai
  if (isInAIMode(user)) {
    try {
      // show as typing
      await message.channel.sendTyping();
      const aiResponse = await sendMessageToCharacter(message.content, user);

      if (aiResponse) {
        refreshAISession(user); // timeout counter after the ai responds, not if the ai chooses to ignore the message.
        await message.channel.send(`${aiResponse}`);
      } else {
        return; // ig the ai doesnt even respond sometimes lol
      }

    } catch (error) {
      console.error("error when ai-ing: ", error);
    }

    return; // Don"t process other commands while in AI mode
  }

  // if exit when user types exit
  // if (content === "exit" && isInAIMode(user)) {
  //   endAISession(user);
  //   message.channel.send("im fucking off");
  //   return;
  // }

  // check if user is in stfu state
  if (ping.has(user) && !content.includes("stfu")) {
    ping.delete(user);
    console.log(`ping cleared for ${user}, didn"t say stfu...`);
  }

  if (["nigga", "nigger", "niga", "nega", "niger"].some(thething => content.includes(thething))) {
    message.channel.send("i forgive u 🙏");
  }

  if (content.includes("nazi")) {
    message.channel.send("卐🍪");
  }

  if (content.includes("<@1421622965958742217>")) {
    message.reply("fuck you don't ping me bitch");
    ping.set(user, "pong");
    return;
  }

  if (content.includes("stfu")) {
    const state = ping.get(user);

    if (state === "pong") {
      if (CAI_CONFIG.token) {
        startAISession(user);
        refreshAISession(user); // start timer
        try {
          await message.channel.sendTyping();
          const aiResponse = await sendMessageToCharacter(message.content, user);
          if (aiResponse) {
            await message.channel.send(`${aiResponse}`);
          }
        } catch (error) {
          console.error("error when ai-ing: ", error);
        }
      } else {
        message.channel.send("no u"); // fallback if in case ai isn;t active
      }
      ping.delete(user); // reset state after
      return;
    }
  }
});

process.on("SIGINT", () => {
  console.log("shutting down");
  // clear timeout
  for (const [userId, session] of aiSessions.entries()) {
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
  }
  
  // close ws
  for (const [userId, ws] of wsConnections.entries()) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
  
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);