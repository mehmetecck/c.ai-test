require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping
  ]
});

const ping = new Map();
const aiSessions = new Map(); // userId -> { chatId, characterId, timeout }
const messageBuffer = new Map(); // userId -> { messages: string[], timeout, typingTimeout }
const userTyping = new Map(); // userId -> boolean

const CAI_CONFIG = {
  token: process.env.CAI_TOKEN,
  characterId: process.env.CAI_CHARACTER_ID || "oGuQaiFfi-fwZiwBbw8BBY7edbkhuON6zIRWv_6MOA0",
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

function handleWebSocketMessage(userId, message) {
  console.log("ws message:", message.command || message.error || "unknown", message.request_id);

  if (message.command === "neo_error" || message.error) {
    console.error("c.ai error: ", message);
    const callback = pendingResponses.get(message.request_id);
    if (callback) {
      callback("90% c.ai servers crashing rn, 10% my token expired. try again and if it still doesnt work my tokken is poopoo");
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

  if (message.command === "add_turn" && message.turn.author.author_id !== "534643361") {
    const characterResponse = message.turn.candidates[0]?.raw_content;
    const requestId = message.request_id;
    
    console.log("ai response: ", characterResponse);
    
    const callback = pendingResponses.get(requestId);
    if (callback && characterResponse !== undefined) {
      callback(characterResponse);
      pendingResponses.delete(requestId);
    }
  } else if (message.command === "update_turn" && message.turn.candidates[0].is_final) {
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
            avatar_url: "uploaded/2024/9/30/bg1lcb9D_Hfoz-sU3D-rU1_WnULsymApi4VsD9PJpbQ.webp"
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
          resolve("beynim yetmedi");
        }
      }, 60000);
    });

  } catch (error) {
    console.error("error sending msg with websocket: ", error);
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
  const existingSession = aiSessions.get(userId);
  if (existingSession?.timeout) {
    clearTimeout(existingSession.timeout);
  }
  
  const existingWS = wsConnections.get(userId);
  if (existingWS && existingWS.readyState === WebSocket.OPEN) {
    existingWS.close();
  }

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

  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  session.timeout = setTimeout(() => {
    endAISession(userId);
  }, 60000);

  return true;
}

function endAISession(userId) {
  const session = aiSessions.get(userId);
  if (session?.timeout) {
    clearTimeout(session.timeout);
  }
  
  const ws = wsConnections.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  wsConnections.delete(userId);
  
  const buffer = messageBuffer.get(userId);
  if (buffer?.timeout) {
    clearTimeout(buffer.timeout);
  }
  if (buffer?.typingTimeout) {
    clearTimeout(buffer.typingTimeout);
  }
  messageBuffer.delete(userId);
  userTyping.delete(userId);
  
  aiSessions.delete(userId);
  console.log(`ai exited for ${userId}`);
}

function isInAIMode(userId) {
  return aiSessions.has(userId);
}

async function processBufferedMessages(user, message) {
  const buffer = messageBuffer.get(user);
  if (!buffer || buffer.messages.length === 0) return;

  const bufferedMessages = buffer.messages;
  messageBuffer.delete(user);
  userTyping.delete(user);

  const formattedMessage = bufferedMessages.map(msg => 
    `{{${message.author.username}}}: ${msg}`
  ).join('\n');

  await message.channel.sendTyping();
  
  const aiResponse = await sendMessageToCharacter(formattedMessage, user);

  if (aiResponse === undefined) {
    await message.channel.send(`​`);
    refreshAISession(user);
  } else if (aiResponse && aiResponse.trim()) {
    const cleanResponse = aiResponse.replace(/\*[^*]*\*/g, '').trim();
    if (cleanResponse) {
      await message.channel.send(`${cleanResponse}`);
    }
    refreshAISession(user);
  } else {
    await message.channel.send(`im fucking dumb so i need more time to think. try in like 5 secs.`);
    refreshAISession(user);
  }
}

client.once("ready", () => {
  console.log(`${client.user.tag}`);
  console.log(`c.ai ${CAI_CONFIG.token ? "enabled" : "disabled"}`);
});

client.on("typingStart", (typing) => {
  const user = typing.user.id;
  
  if (!isInAIMode(user)) return;
  
  userTyping.set(user, true);
  
  const buffer = messageBuffer.get(user);
  if (buffer?.typingTimeout) {
    clearTimeout(buffer.typingTimeout);
    buffer.typingTimeout = null;
  }
  
  console.log(`${typing.user.username} started typing`);
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const content = message.content.trim().toLowerCase();
  const user = message.author.id;

  if (isInAIMode(user)) {
    try {
      let buffer = messageBuffer.get(user);
      if (!buffer) {
        buffer = { messages: [], timeout: null, typingTimeout: null };
        messageBuffer.set(user, buffer);
      }

      buffer.messages.push(message.content);

      if (buffer.timeout) {
        clearTimeout(buffer.timeout);
      }
      if (buffer.typingTimeout) {
        clearTimeout(buffer.typingTimeout);
      }

      userTyping.set(user, false);

      buffer.typingTimeout = setTimeout(async () => {
        if (!userTyping.get(user)) {
          console.log(`${message.author.username} stopped typing, processing messages`);
          await processBufferedMessages(user, message);
        }
      }, 3000);

    } catch (error) {
      console.error("error when ai-ing: ", error);
    }

    return;
  }

  if (ping.has(user) && !content.includes("stfu")) {
    ping.delete(user);
    console.log(`ping cleared for ${user}, didn"t say stfu...`);
  }

  if (["nigga", "nigger", "niga", "nega", "niger"].some(thething => content.includes(thething))) {
    message.channel.send("i forgive u 🙏");
  }

  if (content.includes("nazi")) {
    message.channel.send("✌🪬");
  }

  if (content.includes("<@1421622965958742217>")) {
    if (CAI_CONFIG.token) {
      startAISession(user);
      refreshAISession(user);
      message.reply("fuck you don't ping me bitch");
    } else {
      message.reply("fuck you don't ping me bitch");
    }
    return;
  }
});

process.on("SIGINT", () => {
  console.log("shutting down");
  for (const [userId, session] of aiSessions.entries()) {
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
  }
  
  for (const [userId, ws] of wsConnections.entries()) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
  
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);