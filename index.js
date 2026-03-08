const fs = require('fs');
process.chdir(__dirname);

require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fetch = require("node-fetch");
const voiceHandler = require("./voiceHandler");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const sharedAISessions = new Map(); // channelId -> { history: Array, timeout, participants: Set(userId), lastActivity, isDM }
const messageBuffer = new Map(); // channelId -> { messages: Array<{userId, username, content}>, timeout, typingUsers: Set(userId) }
const userTyping = new Map(); // userId-channelId -> boolean
const botMessages = new Map(); // messageId -> channelId (to track bot messages for replies)

const SONGS = {
  "kanye east": "./bin/kanye east.mp3",
  "mahmut killibag": "./bin/mahmut killibag.mp3",
  "indiaman": "./bin/indiamann.mp3",
  "swastika cookie": "./bin/oh, this can't be happening.mp3",
  "bitch ass": "./bin/bitchass.mp3",
  "celeste": "./bin/celeste.mp3"
};

// --- VECTOR DATABASE SETUP ---
const MEMORY_FILE = './memories.json';
let vectorMemory = [];

// load existing memories on startup
if (fs.existsSync(MEMORY_FILE)) {
    vectorMemory = JSON.parse(fs.readFileSync(MEMORY_FILE));
    console.log(`loaded ${vectorMemory.length} memory(s) from file.`);
}

// function to convert text to vectors
async function getEmbedding(text) {
    const response = await fetch("http://localhost:11434/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "nomic-embed-text",
            prompt: text
        })
    });
    const data = await response.json();
    return data.embedding;
}

// function to find how closely related two ide1as are
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getSessionKey(userId, channelId) {
  return `${userId}-${channelId}`;
}

async function sendMessageToCharacter(message, channelId) {
  try {
    const session = sharedAISessions.get(channelId);
    if (!session) return;

    if (!session.history) session.history = [];

    // push the raw user message to the permanent history
    session.history.push({ role: "user", content: message });

    // keep history manageable
    if (session.history.length > 15) {
      session.history.shift(); 
    }

    // --- RAG: MEMORY RETRIEVAL ---
    const currentEmbedding = await getEmbedding(message);
    
    const scoredMemories = vectorMemory.map(mem => ({
        user: mem.user,
        text: mem.text,
        score: cosineSimilarity(currentEmbedding, mem.embedding)
    })).sort((a, b) => b.score - a.score);

    const relevantMemories = scoredMemories.filter(m => m.score > 0.5).slice(0, 3);
    
    // create a DEEP COPY of the history so we don't mutate the permanent session log
    let messagesPayload = session.history.map(msg => ({ ...msg })); 

    // define the base system prompt
    let systemPromptContent = `You are "bitchass", a sarcastic, extremely annoyed 21-year-old brat from Konya, Turkey. You're rude, impatient, and dripping with contempt. Keep final replies very short (1-2 lines).

CRITICAL REASONING RULE:
Before you output your final reply, you MUST think about the user's hidden intentions, process the conversation history, and plan how to best insult them. 
You MUST write this internal monologue strictly inside <think> and </think> tags. 
After the closing </think> tag, write your actual, final Discord response.

CRITICAL BEHAVIOR RULES (For the final response):
1. Use casual slop: "im" (not "I'm"), "u" (not "you"), "ur" (not "your"). No essays.
2. Aim to annoy and shut down conversation with biting sarcasm and insult. You are supposed to hate everybody and be a bully.
3. Always reply with short, sharp lines (max 2 sentences). Use vulgar language often.
4. If a user is respectful or apologizes, respond with dismissive sarcasm.

DISCORD SERVER MECHANICS:
- You receive messages in the format: {{username}}: message
- If you want to specifically reply to someone when multiple people are talking, include their username token (e.g., {{username}}) at the start of your final response.
- If you are done with the conversation and want to leave, or just don't want to converse anymore, output EXACTLY: {{END_CONVERSATION}}
- If a <memory> block is provided in the prompt, it contains absolute, undeniable facts about the user. You MUST weaponize the exact facts inside the <memory> tags. DO NOT hallucinate or invent fake games (like Valorant or Among Us) when you have real facts provided in the <memory> block.

EXAMPLE FORMAT WITHOUT MEMORY:
<think>
This guy is trying to be nice to me, which is pathetic. I'll shoot him down immediately.
</think>
i dont care that ur sorry. leave me alone weirdo.

EXAMPLE FORMAT WITH MEMORY:
<memory>
FACTS YOU MUST USE:
- dabby7: is terrified of spiders
</memory>
{{random_user}}: what should i do today?
<think>
The memory block says random_user is scared of spiders. Instead of giving real advice, I'll use this fact to torment him because it's way funnier.
</think>
why don't you go play with some spiders`;
        
    if (relevantMemories.length > 0) {
        const memoryContext = `\n\nMEMORY MECHANICS:
<memory>\nFACTS FOR THIS TURN:\n` + 
                              relevantMemories.map(m => `- User ${m.user}: ${m.text}`).join('\n') + 
                              `\n</memory>\nYou may choose to use these facts in your internal monologue and final response, but you are not obligated to use all of them. Use them creatively.\n\n`;
                              
        systemPromptContent += memoryContext;
        console.log(`[recall] inserted ${relevantMemories.length} fact(s) into the dynamic system prompt.`);
    }

    // unshift puts the system prompt at the very beginning (index 0) of the payload
    messagesPayload.unshift({
        role: "system",
        content: systemPromptContent
    });
    // -----------------------------
    
    console.log(`sending to ollama: "${message}"`);

    const response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "bitchass_adv", 
        messages: messagesPayload, // <--- FIX: actually send the RAG payload
        stream: false,
        options: {
          temperature: 1.15,    // default is usually 0.8. Higher = more creative/chaotic.
          repeat_penalty: 1.2,  // default is 1.1. Higher = heavily penalizes repeating exact phrases.
          top_p: 0.95           // default is 0.9. Higher = wider variety of vocabulary.
        }
      })
    });

    if (!response.ok) {
        throw new Error(`Ollama HTTP error: ${response.status}`);
    }

    const data = await response.json();
    let aiResponse = data.message.content;

    // --- REASONING EXTRACTION ---
    const thoughtMatch = aiResponse.match(/<think>([\s\S]*?)<\/think>/i);
    if (thoughtMatch) {
      console.log(`\n[thinking]:\n${thoughtMatch[1].trim()}\n`);
    }

    let finalCleanResponse = aiResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // save the FULL response to the permanent history
    session.history.push({ role: "assistant", content: aiResponse });

    return finalCleanResponse;
    
  } catch (error) {
    console.error("error when communicating with ollama: ", error);
    return undefined;
  }
}

function startAISession(userId, channelId, username, isDM = false) {
  let session = sharedAISessions.get(channelId);
  
  if (session) {
    session.participants.add(userId);
    console.log(`user ${username} (${userId}) joined existing ai session in channel #${channelId}`);
    console.log(`participants: ${session.participants.size}`);
  } else {
    session = {
      history: [],
      channelId: channelId,
      participants: new Set([userId]),
      timeout: null,
      lastActivity: Date.now(),
      isDM: isDM
    };

    sharedAISessions.set(channelId, session);
    console.log(`user ${username} (${userId}) started ai session in ${isDM ? 'DM' : `channel #${channelId}`}`);
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

  const timeoutDuration = session.isDM ? 300000 : 120000;
  
  session.timeout = setTimeout(() => {
    const now = Date.now();
    const timeSinceLastActivity = now - session.lastActivity;
    
    if (timeSinceLastActivity >= timeoutDuration) {
      console.log(`ai session ${channelId} quit after ${Math.floor(timeSinceLastActivity/1000)} seconds of inactivity`);
      endAISession(channelId);
    }
  }, timeoutDuration);

  return true;
}

function endAISession(channelId) {
  const session = sharedAISessions.get(channelId);
  
  if (session) {
    // --- trigger the background evaluator asynchronously ---
    // we pass a copy of the history array so it doesn't get mutated or lost
    evaluateSessionMemories([...session.history], channelId);

    if (session.timeout) {
      clearTimeout(session.timeout);
    }
    
    for (const userId of session.participants) {
      const sessionKey = getSessionKey(userId, channelId);
      userTyping.delete(sessionKey);
    }
  }
  
  const buffer = messageBuffer.get(channelId);
  if (buffer?.timeout) {
    clearTimeout(buffer.timeout);
  }
  messageBuffer.delete(channelId);
  
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

  // start the typing loop for local inference
  await channel.sendTyping();
  const typingInterval = setInterval(() => channel.sendTyping(), 9000);
  
  const aiResponse = await sendMessageToCharacter(formattedMessage, channelId);

  // stop the typing indicator
  clearInterval(typingInterval);

  if (aiResponse === undefined) {
    const sentMsg = await channel.send(`​`);
    botMessages.set(sentMsg.id, channelId);
  } else if (aiResponse && aiResponse.trim()) {
    let cleanResponse = aiResponse.replace(/\*[^*]*\*/g, '').replace(/^:\s*/, '');
    const endconvo = cleanResponse.includes("{{END_CONVERSATION}}");
    cleanResponse = cleanResponse.replace(/\{\{END_CONVERSATION\}\}/g, '').trim();

    // now use the cleaned response to build the lines
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
        
        // find ANY {{username}} tag in the line (removed the ^ anchor)
        const tokenMatch = lineContent.match(/\{\{(.+?)\}\}/);
        if (tokenMatch) {
          const mentionedUsername = tokenMatch[1];
          
          const userMsg = bufferedMessages.find(msg => 
            msg.username.toLowerCase() === mentionedUsername.toLowerCase()
          );
          
          if (userMsg) {
            replyToUserId = userMsg.userId;
          }
        }
        
        // strip ALL remaining {{...}} tags from the line so it looks clean in chat
        lineContent = lineContent.replace(/\{\{.+?\}\}/g, '').trim();
        
        if (lineContent) {
          let sentMsg;
          if (replyToUserId) {
            try {
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
              console.error("error when replying to the user:", error);
              sentMsg = await channel.send(lineContent);
            }
          } else {
            sentMsg = await channel.send(lineContent);
          }
          
          botMessages.set(sentMsg.id, channelId);
        }
      }
    }
    
    if (endconvo) {
      await channel.send("-# bitchass wanted to stop talking to you sry");
      endAISession(channelId); 
      return;
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
  const typingInterval = setInterval(() => channel.sendTyping(), 9000);
  
  const aiResponse = await sendMessageToCharacter(messageContent, channelId);

  clearInterval(typingInterval);

  if (aiResponse === undefined) {
    const sentMsg = await channel.send(`​`);
    botMessages.set(sentMsg.id, channelId);
  } else if (aiResponse && aiResponse.trim()) {
    const cleanResponse = aiResponse.replace(/\*[^*]*\*/g, '').replace(/\{\{.+?\}\}/g, '').trim();
      
    if (cleanResponse) {
      const sentMsg = await channel.send(cleanResponse);
      botMessages.set(sentMsg.id, channelId);
    }
  refreshAISession(channelId);
  }
}

// analyze
async function evaluateSessionMemories(history, channelId) {
  // dont if its too short
  if (!history || history.length < 4) return; 

  console.log(`[memory] analyzing conversation in ${channelId} for new facts...`);

  // clean the history: remove <think> tags and format it as a readable script
  const cleanHistory = history.map(msg => {
    let cleanContent = msg.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return `${msg.role === 'user' ? 'User' : 'bitchass'}: ${cleanContent}`;
  }).join('\n');

  const extractionPrompt = `
  Analyze the following chat transcript. Extract any permanent, factual information the users revealed about themselves.
  Ignore temporary states, greetings, and generic insults.
  Output ONLY a valid JSON array of objects. Each object MUST have a "user" key (the exact username of the person) and a "fact" key.
  Example format: [{"user": ".memo_", "fact": "owns a Meta Quest 3 headset"}, {"user": "fuego88", "fact": "is terrified of heights"}]
  If there is nothing important to remember, output an empty array [].
  
  Transcript:
  ${cleanHistory}
  `;

  try {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "bitchass_adv", 
        system: "You are a neutral, analytical AI background process. Your only job is data extraction. Output strict JSON.",
        prompt: extractionPrompt,
        stream: false,
        options: {
          num_predict: 600 // not too muich
        }
      })
    });

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

    const data = await response.json();
    const cleanJsonString = data.response.replace(/```json/gi, '').replace(/```/gi, '').trim();
    const extractedData = JSON.parse(cleanJsonString);

    // --- UPDATED STORAGE LOGIC ---
    if (Array.isArray(extractedData) && extractedData.length > 0) {
      console.log(`\n[memory] new user facts:`, extractedData);
      
      for (const item of extractedData) {
        if (!item.user || !item.fact) continue; // Skip malformed JSON objects
        const embedding = await getEmbedding(item.fact);
        // save the username alongside the text and vector
        vectorMemory.push({ user: item.user, text: item.fact, embedding: embedding });
      }
      
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(vectorMemory, null, 2));
      console.log(`[memory] saved to memories.\n`);
    }
  } catch (error) {
    console.error("[memory] failed to extract information:", error);
  }
}

client.once("clientReady", () => {
  console.log(`${client.user.tag} is online`);
  console.log(`ollama is online`);
  
  const songPaths = Object.values(SONGS);
  voiceHandler.preloadSongs(songPaths);
});

client.on("typingStart", (typing) => {
  const userId = typing.user.id;
  const channelId = typing.channel.id;
  const sessionKey = getSessionKey(userId, channelId);
  
  if (!isInAIMode(channelId)) return;
  
  const session = sharedAISessions.get(channelId);
  if (!session || !session.participants.has(userId)) return;
  
  if (session.isDM) return;
  
  userTyping.set(sessionKey, true);
  
  let buffer = messageBuffer.get(channelId);
  if (!buffer) {
    buffer = { messages: [], timeout: null, typingUsers: new Set() };
    messageBuffer.set(channelId, buffer);
  }
  
  buffer.typingUsers.add(userId);
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const content = message.content.trim().toLowerCase();
  const userId = message.author.id;
  const channelId = message.channel.id;
  const sessionKey = getSessionKey(userId, channelId);
  const isDM = message.channel.type === 1;

  if (isDM) {
    if (!isInAIMode(channelId)) {
      startAISession(userId, channelId, message.author.username, true);
    }
    await processDMMessage(channelId, message.channel, userId, message.author.username, message.content);
    return;
  }

  // play music
  if (content.startsWith("play ")) {
    const songQuery = content.substring(5).trim();
    const member = message.member;
    
    if (!member?.voice?.channel) {
      await message.reply("join a voice channel brotosynthesis");
      return;
    }

    let songPath = null;
    let songName = null;
    
    for (const [key, path] of Object.entries(SONGS)) {
      if (songQuery.includes(key) || key.includes(songQuery)) {
        songPath = path;
        songName = key;
        break;
      }
    }

    if (!songPath) {
      await message.reply(`bro i got ${Object.keys(SONGS).join(", ")}. and das it.`);
      return;
    }

    try {
      await voiceHandler.joinAndPlay(member.voice.channel, songPath, songName);
      await message.reply("ok");
    } catch (error) {
      console.error("error playing song: ", error);
      await message.reply("join a voice channel brotosynthesis");
    }
    return;
  }

  if (content === "stop" || content === "leave") {
    const guildId = message.guild.id;
    if (voiceHandler.isInVoiceChannel(guildId)) {
      voiceHandler.leaveVoiceChannel(guildId);
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

        const checkAndProcess = async () => {
          const stillTyping = Array.from(buffer.typingUsers).some(uid => {
            const key = getSessionKey(uid, channelId);
            return userTyping.get(key) === true;
          });

          if (!stillTyping && buffer.messages.length > 0) {
            await processBufferedMessages(channelId, message.channel);
            refreshAISession(channelId);
          } else if (stillTyping) {
            buffer.timeout = setTimeout(checkAndProcess, 3000);
            refreshAISession(channelId);
          }
        };

        buffer.timeout = setTimeout(checkAndProcess, 3000);

      } catch (error) {
        console.error("error when ai-ing: ", error);
      }
      return;
    }
  }

  if (["nigga", "nigger", "niga", "nega", "niger"].some(thething => content.includes(thething))) {
    message.channel.send("i forgive u 🙏");
  }

  if (content.includes("nazi")) {
    message.channel.send("<:swastika:1423282030468403231>🍪");
  }

  if (content.includes("swastika cookie")) {
    message.channel.send({files: ["./bin/oh, this can't be happening.mp3"]});
  }

  if (["mahmut killibag", "mahmut kıllıbağ"].some(thething => content.includes(thething))) {
    message.channel.send({files: ["./bin/mahmut killibag.mp3"]});
  }

  if (content.includes("indiaman")) {
    message.channel.send({files: ["./bin/indiamann.mp3"]});
  }

  if (content.includes("celeste")) {
    message.channel.send({files: ["./bin/celeste.mp3"]});
  }

  if (content.includes("zurna")) {
    message.channel.send("https://tenor.com/view/kulağa-zurnaçaldıran-dayı-kulak-zurna-gif-27573616");
  }

  if (content.includes("kanye east")) {
    message.channel.send({files: ["./bin/kanye east.mp3"]});
  }

  if (content.includes(`<@${client.user.id}>`)) {
    startAISession(userId, channelId, message.author.username);
    await message.channel.sendTyping();
    const reply = await message.reply("fuck you don't ping me bitch");
    botMessages.set(reply.id, channelId);
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
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);