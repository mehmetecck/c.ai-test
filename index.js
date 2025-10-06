require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fetch = require("node-fetch");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping
  ],
  partials: [Partials.Channel, Partials.Message]
});

const ping = new Map();
const sharedAISessions = new Map(); // channelId -> { chatId, characterId, timeout, participants: Set(userId), lastActivity, isDM }
const messageBuffer = new Map(); // channelId -> { messages: Array<{userId, username, content}>, timeout, typingUsers: Set(userId) }
const userTyping = new Map(); // userId-channelId -> boolean
const botMessages = new Map(); // messageId -> channelId (to track bot messages for replies)

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

function getSessionKey(userId, channelId) {
  return `${userId}-${channelId}`;
}

async function createCharacterAIWebSocket(channelId) {
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
        console.log(`ws connected for channel ${channelId}`);
        wsConnections.set(channelId, ws);
        resolve(ws);
      });

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          handleWebSocketMessage(channelId, message);
        } catch (error) {
          console.error("error parsing ws, wth??? ", error);
        }
      });

      ws.on("error", (error) => {
        console.error("ws error:", error);
        wsConnections.delete(channelId);
        reject(error);
      });

      ws.on("close", () => {
        console.log(`ws closed for channel ${channelId}`);
        wsConnections.delete(channelId);
      });
    });

  } catch (error) {
    console.error("error generating ws: ", error);
    return null;
  }
}


function handleWebSocketMessage(channelId, message) {
  console.log("ws message:", message.command || message.error || "unknown", message.request_id);

  if (message.command === "neo_error" || message.error) {
    console.error("c.ai error: ", message);
    const pending = pendingResponses.get(message.request_id);
    if (pending) {
      if (pending.fallbackTimeout) clearTimeout(pending.fallbackTimeout);
      pending.resolve("90% c.ai servers crashing rn, 10% my token expired. try again and if it still doesnt work my tokken is poopoo");
      pendingResponses.delete(message.request_id);
    }
    return;
  }

  if (message.command === "create_chat_response") {
    console.log("chat generated");
    const pending = pendingResponses.get(message.request_id);
    if (pending) {
      pending.resolve();
      pendingResponses.delete(message.request_id);
    }
    return;
  }

  if (message.command === "add_turn" && message.turn.author.author_id !== "534643361") {
    const characterResponse = message.turn.candidates[0]?.raw_content;
    const requestId = message.request_id;
    
    console.log("ai response: ", characterResponse);
    
    const pending = pendingResponses.get(requestId);
    if (pending && characterResponse !== undefined) {
      pending.intermediateResponse = characterResponse;
      
      // fallback timeout
      if (pending.fallbackTimeout) {
        clearTimeout(pending.fallbackTimeout);
      }
      pending.fallbackTimeout = setTimeout(() => {
        console.log("no final response received, using intermediate");
        if (pendingResponses.has(requestId)) {
          pending.resolve(pending.intermediateResponse);
          pendingResponses.delete(requestId);
        }
      }, 3000); // final response wait
    }
  } else if (message.command === "update_turn" && message.turn.candidates[0].is_final) {
    const characterResponse = message.turn.candidates[0].raw_content;
    const requestId = message.request_id;
    
    console.log("final ai response: ", characterResponse);
    
    const pending = pendingResponses.get(requestId);
    if (pending) {
      if (pending.fallbackTimeout) {
        clearTimeout(pending.fallbackTimeout);
      }
      pending.resolve(characterResponse);
      pendingResponses.delete(requestId);
    }
  }
}

async function createNewChat(channelId, characterId) {
  try {
    let ws = wsConnections.get(channelId);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = await createCharacterAIWebSocket(channelId);
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
      pendingResponses.set(requestId, {
        resolve: () => resolve(chatId),
        intermediateResponse: null,
        fallbackTimeout: null
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

async function sendMessageViaWebSocket(channelId, messageText, characterId, chatId, username) {
  try {
    let ws = wsConnections.get(channelId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = await createCharacterAIWebSocket(channelId);
      if (!ws) {
        throw new Error("failed to connect with ws connections");
      }
    }

    if (!chatId) {
      console.log("generating new chat... ... ... ");
      chatId = await createNewChat(channelId, characterId);
      if (!chatId) {
        throw new Error("failed new chat");
      }
      console.log("new chat at ", chatId);
      
      const session = sharedAISessions.get(channelId);
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
        user_name: username || "memo",
        turn: {
          turn_key: {
            turn_id: turnId,
            chat_id: chatId
          },
          author: {
            author_id: "534643361",
            is_human: true,
            name: username || "memo",
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
      pendingResponses.set(requestId, {
        resolve,
        intermediateResponse: null,
        fallbackTimeout: null
      });
      
      setTimeout(() => {
        if (pendingResponses.has(requestId)) {
          const pending = pendingResponses.get(requestId);
          if (pending.fallbackTimeout) clearTimeout(pending.fallbackTimeout);
          pendingResponses.delete(requestId);
          resolve("beynim yetmedi");
        }
      }, 60000);
    });

  } catch (error) {
    console.error("error sending msg with websocket: ", error);
  }
}

async function sendMessageToCharacter(message, channelId) {
  try {
    const session = sharedAISessions.get(channelId);
    if (!session) {
      return;
    }
    
    const characterId = CAI_CONFIG.characterId;
    const chatId = session.chatId;
    
    console.log(`sending to c.ai: "${message}"`);
    
    const response = await sendMessageViaWebSocket(channelId, message, characterId, chatId, "group");
    
    return response;
    
  } catch (error) {
    console.error("error when communicating with c.ai: ", error);
  }
}

function startAISession(userId, channelId, username, isDM = false) {
  let session = sharedAISessions.get(channelId);
  
  if (session) {
    // join chat
    session.participants.add(userId);
    console.log(`user ${username} (${userId}) joined existing ai session in channel #${channelId}`);
    console.log(`participants: ${session.participants.size}`);
  } else {
    // make new chat
    const existingWS = wsConnections.get(channelId);
    if (existingWS && existingWS.readyState === WebSocket.OPEN) {
      existingWS.close();
    }

    session = {
      chatId: null,
      characterId: CAI_CONFIG.characterId,
      channelId: channelId,
      participants: new Set([userId]),
      timeout: null,
      lastActivity: Date.now(),
      isDM: isDM
    };

    sharedAISessions.set(channelId, session);
    console.log(`user ${username} (${userId}) started ai session in ${isDM ? 'dm' : `channel #${channelId}`}`);
    console.log(`using : ${session.characterId} in c.ai`);
  }
  
  refreshAISession(channelId);
}

function refreshAISession(channelId) {
  const session = sharedAISessions.get(channelId);
  if (!session) return false;

  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  session.lastActivity = Date.now();

  // dms 10 mins
  const timeoutDuration = session.isDM ? 600000 : 30000;

  session.timeout = setTimeout(() => {
    endAISession(channelId);
  }, timeoutDuration);

  return true;
}

function endAISession(channelId) {
  const session = sharedAISessions.get(channelId);
  
  if (session?.timeout) {
    clearTimeout(session.timeout);
  }
  
  const ws = wsConnections.get(channelId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  wsConnections.delete(channelId);
  
  const buffer = messageBuffer.get(channelId);
  if (buffer?.timeout) {
    clearTimeout(buffer.timeout);
  }
  messageBuffer.delete(channelId);
  
  if (session) {
    for (const userId of session.participants) {
      const sessionKey = getSessionKey(userId, channelId);
      userTyping.delete(sessionKey);
    }
  }
  
  sharedAISessions.delete(channelId);
  console.log(`ai session ended for channel ${channelId}`);
}

function isInAIMode(channelId) {
  return sharedAISessions.has(channelId);
}

function addUserToSession(userId, channelId, username) {
  if (!isInAIMode(channelId)) {
    startAISession(userId, channelId, username);
  } else {
    const session = sharedAISessions.get(channelId);
    if (session && !session.participants.has(userId)) {
      session.participants.add(userId);
      console.log(`user ${username} (${userId}) joined chat in channel #${channelId}`);
      console.log(`participants: ${session.participants.size}`);
    }
  }
}

async function processBufferedMessages(channelId, channel) {
  const buffer = messageBuffer.get(channelId);
  if (!buffer || buffer.messages.length === 0) return;

  const bufferedMessages = buffer.messages;
  messageBuffer.delete(channelId);

  const formattedMessage = bufferedMessages.map(msg => 
    `{{${msg.username}}}: ${msg.content}`
  ).join('\n');

  await channel.sendTyping();
  
  const aiResponse = await sendMessageToCharacter(formattedMessage, channelId);

  if (aiResponse === undefined) {
    const sentMsg = await channel.send(`​`);
    botMessages.set(sentMsg.id, channelId);
    refreshAISession(channelId);
  } else if (aiResponse && aiResponse.trim()) {
    const cleanResponse = aiResponse
      .replace(/\*[^*]*\*/g, '') // remove italic roleplay
      .replace(': ', '') // remove first ": ""
    if (cleanResponse) {
      const lines = cleanResponse.split('\n').filter(line => line.trim());
      
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
          await channel.sendTyping();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        let lineContent = lines[i].trim();
        let replyToUserId = null;
        
        const tokenMatch = lineContent.match(/^{{(.+?)}}\s*/); // awlays {{ }}
        if (tokenMatch) {
          const mentionedUsername = tokenMatch[1];
          lineContent = lineContent.replace(/^{{.+?}}\s*/, '').trim();
          
          const userMsg = bufferedMessages.find(msg => 
            msg.username.toLowerCase() === mentionedUsername.toLowerCase()
          );
          
          if (userMsg) {
            replyToUserId = userMsg.userId;
          }
        }
        
        if (lineContent) {
          // find last message from the user to reply to
          let sentMsg;
          if (replyToUserId) {
            try {
              // find last messages
              const recentMessages = await channel.messages.fetch({ limit: 50 });
              const userLastMessage = recentMessages.find(msg => 
                msg.author.id === replyToUserId && !msg.author.bot
              );
              
              if (userLastMessage) {
                sentMsg = await userLastMessage.reply(lineContent);
              } else {
                sentMsg = await channel.send(lineContent);
              }
            } catch (error) {
              console.error("error replying to user:", error);
              sentMsg = await channel.send(lineContent);
            }
          } else {
            sentMsg = await channel.send(lineContent);
          }
          
          botMessages.set(sentMsg.id, channelId);
        }
      }
    }
    refreshAISession(channelId);
  } else {
    const sentMsg = await channel.send(`im fucking dumb so i need more time to think. try in like 5 secs.`);
    botMessages.set(sentMsg.id, channelId);
    refreshAISession(channelId);
  }
}

async function processDMMessage(channelId, channel, userId, username, messageContent) {
  await channel.sendTyping();
  
  const aiResponse = await sendMessageToCharacter(messageContent, channelId);

  if (aiResponse === undefined) {
    const sentMsg = await channel.send(`​`);
    botMessages.set(sentMsg.id, channelId);
    refreshAISession(channelId);
  } else if (aiResponse && aiResponse.trim()) {
    const cleanResponse = aiResponse.replace(/\*[^*]*\*/g, '').trim();
    if (cleanResponse) {
      const sentMsg = await channel.send(cleanResponse);
      botMessages.set(sentMsg.id, channelId);
    }
    refreshAISession(channelId);
  } else {
    const sentMsg = await channel.send(`im fucking dumb so i need more time to think. try in like 5 secs.`);
    botMessages.set(sentMsg.id, channelId);
    refreshAISession(channelId);
  }
}

client.once("ready", () => {
  console.log(`${client.user.tag}`);
  console.log(`c.ai ${CAI_CONFIG.token ? "enabled" : "disabled"}`);
});

client.on("typingStart", (typing) => {
  const userId = typing.user.id;
  const channelId = typing.channel.id;
  const sessionKey = getSessionKey(userId, channelId);
  
  if (!isInAIMode(channelId)) return;
  
  const session = sharedAISessions.get(channelId);
  if (!session || !session.participants.has(userId)) return;
  
  userTyping.set(sessionKey, true);
  
  let buffer = messageBuffer.get(channelId);
  if (!buffer) {
    buffer = { messages: [], timeout: null, typingUsers: new Set() };
    messageBuffer.set(channelId, buffer);
  }
  
  buffer.typingUsers.add(userId);
  
  console.log(`${typing.user.username} started typing in ${channelId} (active typists: ${buffer.typingUsers.size})`);
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  console.log(`message @ ${message.guild ? `server ${message.guild.name}` : 'dm'} from @${message.author.username}: ${message.content}`);

  const content = message.content.trim().toLowerCase();
  const userId = message.author.id;
  const channelId = message.channel.id;
  const sessionKey = getSessionKey(userId, channelId);
  const isDM = !message.guild; // check if msg is from dms

  console.log(`dm: ${isDM}, channel: #${channelId}`);

  if (isDM) {
    console.log(`dm process from user #${message.author.username}`);
    
    if (!CAI_CONFIG.token) {
      console.log("no cai token");
      await message.reply("c.ai is not configured");
      return;
    }

    if (!isInAIMode(channelId)) {
      console.log(`starting new ai chat in dms for #${message.author.username}`);
      startAISession(userId, channelId, message.author.username, true);
    }

    const session = sharedAISessions.get(channelId);
    
    if (session && session.participants.has(userId)) {
      try {
        let buffer = messageBuffer.get(channelId);
        if (!buffer) {
          buffer = { messages: [], timeout: null, typingUsers: new Set() };
          messageBuffer.set(channelId, buffer);
        }

        buffer.messages.push({
          userId: userId,
          username: message.author.username,
          content: message.content
        });

        if (buffer.timeout) {
          clearTimeout(buffer.timeout);
        }

        userTyping.set(sessionKey, false);
        buffer.typingUsers.delete(userId);
        
        console.log(`${message.author.username} sent dm (still typing: ${buffer.typingUsers.size})`);

        const checkAndProcess = async () => {
          const stillTyping = Array.from(buffer.typingUsers).some(uid => {
            const key = getSessionKey(uid, channelId);
            return userTyping.get(key) === true;
          });

          if (!stillTyping && buffer.messages.length > 0) {
            console.log(`user stopped typing in dm ${channelId}, processing messages`);
            await processBufferedMessages(channelId, message.channel);
          } else if (stillTyping) {
            console.log(`waiting for user to finish typing in dm...`);
            buffer.timeout = setTimeout(checkAndProcess, 3000);
          }
        };

        buffer.timeout = setTimeout(checkAndProcess, 3000);

      } catch (error) {
        console.error("error when ai-ing in dm: ", error);
      }

      return;
    }
  }

  if (message.reference && message.reference.messageId) {
    const replyChannelId = botMessages.get(message.reference.messageId);
    if (replyChannelId === channelId && isInAIMode(channelId)) {
      addUserToSession(userId, channelId, message.author.username);
    }
  }

  if (isInAIMode(channelId)) {
    const session = sharedAISessions.get(channelId);
    
    if (session && session.participants.has(userId)) {
      try {
        let buffer = messageBuffer.get(channelId);
        if (!buffer) {
          buffer = { messages: [], timeout: null, typingUsers: new Set() };
          messageBuffer.set(channelId, buffer);
        }

        buffer.messages.push({
          userId: userId,
          username: message.author.username,
          content: message.content
        });

        if (buffer.timeout) {
          clearTimeout(buffer.timeout);
        }

        userTyping.set(sessionKey, false);
        buffer.typingUsers.delete(userId);
        
        console.log(`${message.author.username} sent message (still typing: ${buffer.typingUsers.size})`);

        const checkAndProcess = async () => {
          const stillTyping = Array.from(buffer.typingUsers).some(uid => {
            const key = getSessionKey(uid, channelId);
            return userTyping.get(key) === true;
          });

          if (!stillTyping && buffer.messages.length > 0) {
            console.log(`all users stopped typing in ${channelId}, processing messages`);
            await processBufferedMessages(channelId, message.channel);
          } else if (stillTyping) {
            console.log(`waiting for every1 to finish typing... `);
            buffer.timeout = setTimeout(checkAndProcess, 3000);
          }
        };

        buffer.timeout = setTimeout(checkAndProcess, 3000);

      } catch (error) {
        console.error("error when ai-ing: ", error);
      }

      return;
    }
  }

  if (ping.has(userId) && !content.includes("stfu")) {
    ping.delete(userId);
    console.log(`ping cleared for ${userId}, didn"t say stfu...`);
  }

  if (["nigga", "nigger", "niga", "nega", "niger"].some(thething => content.includes(thething))) {
    message.channel.send("i forgive u 🙏");
  }

  if (content.includes("nazi")) {
    message.channel.send("<:swastika:1423282030468403231>🪖");
  }

  if (content.includes("<@1421622965958742217>")) {
    if (CAI_CONFIG.token) {
      startAISession(userId, channelId, message.author.username);
      await message.channel.sendTyping();
      await new Promise(resolve => setTimeout(resolve, 500));
      const reply = await message.reply("fuck you don't ping me bitch");
      botMessages.set(reply.id, channelId);
    } else {
      message.reply("fuck you don't ping me bitch");
    }
    return;
  }
});

process.on("SIGINT", () => {
  console.log("shutting down");
  for (const [channelId, session] of sharedAISessions.entries()) {
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
  }
  
  for (const [channelId, ws] of wsConnections.entries()) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
  
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);