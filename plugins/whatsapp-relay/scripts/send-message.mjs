const DEFAULT_ACK_TIMEOUT_MS = 15_000;

export const MESSAGE_STATUS = Object.freeze({
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5
});

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) {
    return "th";
  }

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatUtcDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value ?? "unknown time");
  }

  const day = date.getUTCDate();
  const month = date.toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC"
  });
  const year = date.getUTCFullYear();
  const rawHour = date.getUTCHours();
  const hour = rawHour % 12 || 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const period = rawHour >= 12 ? "PM" : "AM";
  return `${day}${ordinalSuffix(day)} ${month} ${year} ${hour}:${minute} ${period} UTC`;
}

function sendError(message, { code, retryable = false, details = null } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  error.details = details;
  return error;
}

export function statusLabel(status) {
  switch (Number(status)) {
    case MESSAGE_STATUS.ERROR:
      return "error";
    case MESSAGE_STATUS.PENDING:
      return "pending";
    case MESSAGE_STATUS.SERVER_ACK:
      return "server_ack";
    case MESSAGE_STATUS.DELIVERY_ACK:
      return "delivery_ack";
    case MESSAGE_STATUS.READ:
      return "read";
    case MESSAGE_STATUS.PLAYED:
      return "played";
    default:
      return `status_${status}`;
  }
}

export async function assertCompanionSendAllowed(socket) {
  if (typeof socket?.fetchAccountReachoutTimelock !== "function") {
    return null;
  }

  const restriction = await socket.fetchAccountReachoutTimelock();
  if (!restriction?.isActive) {
    return restriction ?? null;
  }

  const enforcementType = restriction.enforcementType ?? "unknown";
  const endsAt = restriction.timeEnforcementEnds
    ? formatUtcDate(restriction.timeEnforcementEnds)
    : "an unspecified time";
  throw sendError(
    `WhatsApp linked-device sending is restricted until ${endsAt} (${enforcementType}). The account session is authenticated. WhatsApp is rejecting companion-device sends. Use the phone app during this restriction or retry after it ends.`,
    {
      code: "ERR_WHATSAPP_COMPANION_RESTRICTED",
      retryable: false,
      details: restriction
    }
  );
}

function extractFailureDetails(update = {}) {
  const parameters = Array.isArray(update.messageStubParameters)
    ? update.messageStubParameters.filter((value) => value !== undefined && value !== null)
    : [];
  const stubType = update.messageStubType ?? null;
  return {
    parameters,
    stubType
  };
}

export async function sendMessageWithAck(
  socket,
  chatId,
  content,
  { timeoutMs = DEFAULT_ACK_TIMEOUT_MS, preflight = true } = {}
) {
  if (preflight) {
    await assertCompanionSendAllowed(socket);
  }

  if (!socket?.ev || typeof socket.ev.on !== "function" || typeof socket.ev.off !== "function") {
    throw sendError("WhatsApp socket event tracking is unavailable.", {
      code: "ERR_WHATSAPP_ACK_TRACKING_UNAVAILABLE",
      retryable: false
    });
  }

  const bufferedUpdates = new Map();
  let messageId = null;
  let resolveAck;
  let rejectAck;
  let settled = false;

  const ackPromise = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  // The timer can reject before the caller awaits ackPromise (slow media upload).
  // Mark the rejection as handled here so Node does not exit; the caller still gets it.
  ackPromise.catch(() => {});

  const cleanup = () => {
    socket.ev.off("messages.update", handleUpdates);
    clearTimeout(timer);
  };

  const finish = (callback, value) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    callback(value);
  };

  const inspectUpdate = (update = {}) => {
    const status = Number(update.status);
    if (status === MESSAGE_STATUS.ERROR) {
      const failure = extractFailureDetails(update);
      const suffix = failure.parameters.length
        ? ` Server details: ${failure.parameters.join(" | ")}.`
        : "";
      finish(
        rejectAck,
        sendError(`WhatsApp rejected message ${messageId}.${suffix}`, {
          code: "ERR_WHATSAPP_SEND_REJECTED",
          retryable: false,
          details: {
            messageId,
            status,
            ...failure
          }
        })
      );
      return;
    }

    if (Number.isFinite(status) && status >= MESSAGE_STATUS.SERVER_ACK) {
      finish(resolveAck, {
        messageId,
        status,
        statusLabel: statusLabel(status)
      });
    }
  };

  function handleUpdates(updates = []) {
    for (const item of updates) {
      const id = item?.key?.id;
      if (!id) {
        continue;
      }

      if (messageId === id) {
        inspectUpdate(item.update);
      } else {
        bufferedUpdates.set(id, item.update ?? {});
      }
    }
  }

  socket.ev.on("messages.update", handleUpdates);
  const timer = setTimeout(() => {
    finish(
      rejectAck,
      sendError(
        `WhatsApp server acknowledgement timed out${messageId ? ` for message ${messageId}` : ""}. Delivery is unconfirmed.`,
        {
          code: "ERR_WHATSAPP_ACK_TIMEOUT",
          retryable: false,
          details: { messageId, timeoutMs }
        }
      )
    );
  }, timeoutMs);

  try {
    const sent = await socket.sendMessage(chatId, content);
    messageId = sent?.key?.id ?? null;
    if (!messageId) {
      finish(
        rejectAck,
        sendError("WhatsApp accepted the local send call without returning a message ID.", {
          code: "ERR_WHATSAPP_MESSAGE_ID_MISSING",
          retryable: false
        })
      );
    } else if (bufferedUpdates.has(messageId)) {
      inspectUpdate(bufferedUpdates.get(messageId));
    }
  } catch (error) {
    finish(rejectAck, error);
  }

  return ackPromise;
}
