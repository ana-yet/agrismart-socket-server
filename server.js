// ═══════════════════════════════════════════════════════
// AGRISMART SOCKET.IO CHAT SERVER (PURE SOCKET ONLY)
// ═══════════════════════════════════════════════════════

const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const cors = require("cors");
const { OAuth2Client } = require("google-auth-library");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { default: axios } = require("axios");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════
const REST_API_TIMEOUT = 5000; // 5 seconds

// ═══════════════════════════════════════════════════════
// SOCKET.IO CONFIGURATION
// ═══════════════════════════════════════════════════════
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ═══════════════════════════════════════════════════════
// DATA STORAGE (In-Memory - Socket Only)
// ═══════════════════════════════════════════════════════

// Map userId to socketId: { userId: socketId }
const userSocketMap = new Map();
// Map userEmail to socketId: { email: socketId }
const emailSocketMap = new Map();

// Set of online emails
const onlineEmails = new Set();

// Map socketId to userId: { socketId: userId }
const socketUserMap = new Map();

// Store typing status: { conversationId: { userId: isTyping } }
const typingStatus = new Map();

// ═══════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════

// Helper to check if token is a JWT
const isJwt = (token) => {
  return typeof token === "string" && token.split(".").length === 3;
};

const verifyToken = (token) => {
  if (!token) throw new Error("No token provided");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("decoded inside verifyToken:", decoded);
    return decoded;
  } catch (err) {
    throw new Error("Invalid JWT: " + err.message);
  }
};

//
async function saveMessageToDB(messageData, token) {
  try {
    const response = await axios.post(
      `${process.env.REST_API_URL}/api/messages`,
      {
        recipientId: messageData.recipientId,
        message: messageData.message,
        conversationId: messageData.conversationId,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: REST_API_TIMEOUT,
      }
    );

    console.log("✅ Message saved to database:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Failed to save message to database:", error.message);
    // Don't throw - let real-time messaging continue even if DB save fails
    return null;
  }
}

/**
 * Verify JWT token and extract user data (supports both manual JWT and Google ID tokens)
 */
async function verifyTokenAndGetUser(token) {
  if (!token) {
    throw new Error("No token provided");
  }

  let decoded;

  // First try: verify as manual JWT
  if (isJwt(token)) {
    try {
      decoded = verifyToken(token);
      return {
        id: decoded.id || decoded.sub || decoded._id,
        email: decoded.email,
        name: decoded.name,
        loginType: "manual",
      };
    } catch (manualErr) {
      // fall through and try Google token
    }
  }

  // Try Google ID token
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    decoded = ticket.getPayload();
    // console.log("Google decoded:", decoded);
    return {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,

      loginType: "google",
    };
  } catch (googleErr) {
    // both verifications failed
  }

  // If both verifications fail
  throw new Error("Invalid or expired token");
}

/**
 * Get socket ID for a specific user
 */
function getSocketIdByUserId(userId) {
  return userSocketMap.get(userId);
}

/**
 * Get socket ID for a specific email
 */
function getSocketIdByEmail(email) {
  return emailSocketMap.get(email);
}

/**
 * Generate conversation ID between two users
 */
function getConversationId(userId1, userId2) {
  return [userId1, userId2].sort().join("_");
}

/**
 * Get all online users
 */
function getOnlineUsers() {
  return Array.from(userSocketMap.keys());
}

// ═══════════════════════════════════════════════════════
// HEALTH CHECK ENDPOINT
// ═══════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.json({
    status: "AgriSmart Socket.IO Server Running",
    connectedUsers: userSocketMap.size,
    onlineUsers: getOnlineUsers().length,
    message: "Pure Socket.IO server - REST API handled by separate backend",
  });
});

// ═══════════════════════════════════════════════════════
// SOCKET.IO AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    const user = await verifyTokenAndGetUser(token);

    // Attach user info to socket
    socket.userId = user.id;
    socket.userEmail = user.email;
    socket.userName = user.name;
    socket.token = token; //  Store token for REST API calls

    console.log(`✅ Authenticated: ${socket.userEmail} (${socket.userId})`);
    next();
  } catch (error) {
    console.error("Socket authentication error:", error.message);
    next(new Error("Authentication error: Invalid token"));
  }
});

// ═══════════════════════════════════════════════════════
// SOCKET.IO CONNECTION HANDLER
// ═══════════════════════════════════════════════════════

io.on("connection", (socket) => {
  const userId = socket.userId;
  const userName = socket.userName || socket.userEmail.split("@")[0];

  console.log(
    `🔌 User connected: ${userName} (${userId}) - Socket: ${socket.id}`
  );

  // ─────────────────────────────────────────────────────
  // Store user-socket mapping
  // ─────────────────────────────────────────────────────
  userSocketMap.set(userId, socket.id);
  if (socket.userEmail) {
    emailSocketMap.set(socket.userEmail, socket.id);
  }
  socketUserMap.set(socket.id, userId);
  onlineEmails.add(socket.userEmail);

  // ─────────────────────────────────────────────────────
  // Send connection confirmation
  // ─────────────────────────────────────────────────────
  socket.emit("connected", {
    message: "Successfully connected to chat server",
    userId: userId,
    userName: userName,
  });

  // ─────────────────────────────────────────────────────
  // Broadcast user online status to all users
  // ─────────────────────────────────────────────────────
  socket.broadcast.emit("user-online", {
    userId: userId,
    userEmail: socket.userEmail,
    userName: userName,
    timestamp: new Date().toISOString(),
  });

  // Also broadcast the full current online status map to ALL users
  const statusById = {};
  getOnlineUsers().forEach((uid) => {
    statusById[uid] = true;
  });
  const statusByEmail = {};
  onlineEmails.forEach((email) => {
    statusByEmail[email] = true;
  });
  io.emit("online-status", { byId: statusById, byEmail: statusByEmail });

  // ─────────────────────────────────────────────────────
  // EVENT: Join Conversation Room
  // ─────────────────────────────────────────────────────
  socket.on("join-conversation", ({ otherUserId }) => {
    const conversationId = getConversationId(userId, otherUserId);
    socket.join(conversationId);

    console.log(`💬 ${userName} joined conversation: ${conversationId}`);

    socket.emit("conversation-joined", {
      conversationId,
      otherUserId,
    });
  });

  // ─────────────────────────────────────────────────────
  // EVENT: Send Message
  // ─────────────────────────────────────────────────────
  socket.on("send-message", async (data) => {
    const { recipientId, recipientEmail, message, conversationId } = data;

    console.log(
      `📤 Message from ${userName} (${userId}) to ${recipientId}:`,
      message
    );

    const messageData = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      conversationId: conversationId || getConversationId(userId, recipientId),
      senderId: userId,
      senderName: userName,
      recipientId: recipientId,
      message: message,
      timestamp: new Date().toISOString(),
      read: false,
    };

    // 🔥 SAVE TO DATABASE VIA REST API
    const savedMessage = await saveMessageToDB(messageData, socket.token);
    console.log("Saved message response:", savedMessage);

    // If saved successfully, use the DB-generated ID
    if (savedMessage && savedMessage.data && savedMessage.data._id) {
      messageData.id = savedMessage.data._id;
      messageData.dbSaved = true;
    } else {
      messageData.dbSaved = false;
    }

    // Send to recipient if online
    let recipientSocketId = null;
    if (recipientId) {
      recipientSocketId = getSocketIdByUserId(recipientId);
    }
    if (!recipientSocketId && recipientEmail) {
      recipientSocketId = getSocketIdByEmail(recipientEmail);
    }

    if (recipientSocketId) {
      io.to(recipientSocketId).emit(
        "receive-message",
        savedMessage.data || messageData
      );
      // console.log(`✅ Message delivered to ${recipientId} (online)`);
    } else {
      // console.log(
      //   `⏳ Recipient ${recipientId} is offline - message saved to database`
      // );
    }

    // Send confirmation to sender
    socket.emit("message-sent", savedMessage.data || messageData);
    console.log(`📨 Confirmation sent to sender`);

    // Also emit to conversation room
    io.to(messageData.conversationId).emit("new-message", messageData);
  });

  // ─────────────────────────────────────────────────────
  // EVENT: Typing Indicator
  // ─────────────────────────────────────────────────────
  socket.on("typing", ({ recipientId, recipientEmail, isTyping }) => {
    const targetId = recipientId || recipientEmail || "unknown";
    const conversationId = recipientId
      ? getConversationId(userId, recipientId)
      : getConversationId(userId, targetId);

    // Update typing status
    if (!typingStatus.has(conversationId)) {
      typingStatus.set(conversationId, new Map());
    }
    typingStatus.get(conversationId).set(userId, isTyping);

    // Send to recipient
    let recipientSocketId = null;
    if (recipientId) recipientSocketId = getSocketIdByUserId(recipientId);
    if (!recipientSocketId && recipientEmail)
      recipientSocketId = getSocketIdByEmail(recipientEmail);

    if (recipientSocketId) {
      io.to(recipientSocketId).emit("user-typing", {
        userId: userId,
        userName: userName,
        isTyping: isTyping,
        conversationId: conversationId,
      });
    }
  });

  // ─────────────────────────────────────────────────────
  // EVENT: Mark Messages as Read
  // ─────────────────────────────────────────────────────
  socket.on("mark-read", ({ conversationId, messageIds }) => {
    // console.log(`📖 ${userName} marked messages as read in ${conversationId}`);

    // Emit to conversation room
    io.to(conversationId).emit("messages-read", {
      conversationId,
      messageIds,
      readBy: userId,
    });
  });

  // ─────────────────────────────────────────────────────
  // EVENT: Get Online Status
  // ─────────────────────────────────────────────────────
  socket.on("check-online", ({ userIds }) => {
    const onlineStatus = {};

    userIds.forEach((uid) => {
      onlineStatus[uid] = userSocketMap.has(uid);
    });

    socket.emit("online-status", onlineStatus);
  });

  // ─────────────────────────────────────────────────────
  // EVENT: Disconnect
  // ─────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${userName} (${userId})`);

    // Remove from maps
    userSocketMap.delete(userId);
    socketUserMap.delete(socket.id);
    if (socket.userEmail) {
      emailSocketMap.delete(socket.userEmail);
    }

    // Broadcast offline status
    socket.broadcast.emit("user-offline", {
      userId: userId,
      userEmail: socket.userEmail,
      userName: userName,
      timestamp: new Date().toISOString(),
    });

    // Update and broadcast online-status map
    const statusById = {};
    getOnlineUsers().forEach((uid) => {
      statusById[uid] = true;
    });
    onlineEmails.delete(socket.userEmail);
    const statusByEmail = {};
    onlineEmails.forEach((email) => {
      statusByEmail[email] = true;
    });
    io.emit("online-status", { byId: statusById, byEmail: statusByEmail });
  });
});

// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   🚀 AgriSmart Socket Server Running ║
  ║   📡 Port: ${PORT}                       ║
  ║   🔐 Auth: JWT + Google Enabled       ║
  ║   🌍 Environment: ${process.env.NODE_ENV || "development"}      ║
  ║   📝 Pure Socket.IO - No REST API    ║
  ╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
