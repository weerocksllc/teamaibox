import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL query result is invalid");
  return result.rows;
}

function date(value) {
  return value === null || value === undefined ? null : new Date(value);
}

function digest(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("PostgreSQL digest is invalid");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function participant(row) {
  return {
    identityId: row.identity_id,
    role: row.participant_role,
    joinedAt: date(row.joined_at),
    leftAt: date(row.left_at),
    lastReadSequence: Number(row.last_read_sequence),
  };
}

function conversation(row, participants = []) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.conversation_kind,
    title: row.title,
    teamKey: row.team_key,
    directKey: row.direct_key ? digest(row.direct_key) : null,
    createdByIdentityId: row.created_by_identity_id,
    participants,
    lastMessageSequence: Number(row.last_message_sequence),
    revision: Number(row.revision),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function attachment(row) {
  return row ? {
    objectId: row.object_id,
    objectVersion: Number(row.object_version),
    filename: row.filename,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    sha256: digest(row.sha256),
  } : null;
}

function receipt(row) {
  return {
    identityId: row.identity_id,
    state: row.delivery_state,
    deliveredAt: date(row.delivered_at),
    readAt: date(row.read_at),
  };
}

function message(row, attachments = [], delivery = []) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.message_sequence),
    authorIdentityId: row.author_identity_id,
    authorKind: row.author_kind,
    applicationKey: row.application_key,
    idempotencyKey: row.idempotency_key,
    requestDigest: digest(row.request_digest),
    content: row.content,
    attachments,
    delivery,
    replyToMessageId: row.reply_to_message_id,
    createdAt: date(row.created_at),
    editedAt: date(row.edited_at),
    deletedAt: date(row.deleted_at),
  };
}

function event(row) {
  if (!row) return null;
  return {
    id: row.event_id,
    sequence: Number(row.sequence_id),
    type: row.event_type,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    audienceIdentityIds: [...row.audience_identity_ids],
    authorIdentityId: row.author_identity_id,
    data: typeof row.event_data === "string" ? JSON.parse(row.event_data) : structuredClone(row.event_data),
    createdAt: date(row.created_at),
  };
}

function notification(row) {
  return row ? {
    id: row.id,
    identityId: row.identity_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.notification_kind,
    createdAt: date(row.created_at),
    readAt: date(row.read_at),
  } : null;
}

function presence(row) {
  return row ? {
    identityId: row.identity_id,
    state: row.presence_state,
    connectionCount: Number(row.connection_count),
    lastSeenAt: date(row.last_seen_at),
    expiresAt: date(row.expires_at),
    revision: Number(row.revision),
  } : null;
}

async function loadConversation(executor, conversationId, identityId = null, lock = false) {
  const values = [conversationId];
  const membership = identityId ? " AND EXISTS (SELECT 1 FROM platform.messaging_participants p WHERE p.conversation_id=c.id AND p.identity_id=$2 AND p.left_at IS NULL)" : "";
  if (identityId) values.push(identityId);
  const record = rows(await executor.query(`SELECT c.* FROM platform.messaging_conversations c WHERE c.id=$1${membership}${lock ? " FOR UPDATE" : ""}`, values))[0];
  if (!record) return null;
  const participants = rows(await executor.query("SELECT * FROM platform.messaging_participants WHERE conversation_id=$1 ORDER BY joined_at, identity_id", [conversationId])).map(participant);
  return conversation(record, participants);
}

async function loadMessage(executor, messageId) {
  const record = rows(await executor.query("SELECT * FROM platform.messaging_messages WHERE id=$1", [messageId]))[0];
  if (!record) return null;
  const attachments = rows(await executor.query("SELECT * FROM platform.messaging_attachments WHERE message_id=$1 ORDER BY attachment_ordinal", [messageId])).map(attachment);
  const delivery = rows(await executor.query("SELECT * FROM platform.messaging_delivery_receipts WHERE message_id=$1 ORDER BY identity_id", [messageId])).map(receipt);
  return message(record, attachments, delivery);
}

async function appendEvent(executor, { type, conversationId, messageId = null, audienceIdentityIds, authorIdentityId, data, now }) {
  const value = event(rows(await executor.query(`
    INSERT INTO platform.messaging_events (
      conversation_id,message_id,event_type,audience_identity_ids,author_identity_id,event_data,created_at
    ) VALUES ($1,$2,$3,$4::uuid[],$5,$6::jsonb,$7)
    RETURNING *`, [conversationId, messageId, type, audienceIdentityIds, authorIdentityId, JSON.stringify(data), now]))[0]);
  await executor.query("SELECT platform.enqueue_outbox($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [
    "teamaibox.events.v1.messaging",
    `messaging.${type.replaceAll(".", "_")}`,
    "messaging.event",
    value.id,
    value.sequence,
    JSON.stringify({ eventId: value.id }),
    JSON.stringify({ audience: "messaging-realtime" }),
  ]);
  return value;
}

async function audience(executor, conversationId) {
  return rows(await executor.query("SELECT identity_id FROM platform.messaging_participants WHERE conversation_id=$1 AND left_at IS NULL ORDER BY identity_id", [conversationId])).map((row) => row.identity_id);
}

function visibleSql(message = 'message', member = 'participant') {
  return `${message}.message_sequence>${member}.cleared_through_sequence
    AND NOT EXISTS (SELECT 1 FROM platform.messaging_hidden_messages hidden
      WHERE hidden.message_id=${message}.id AND hidden.identity_id=${member}.identity_id)`;
}

async function reopenConversation(db, id, identityId) {
  await db.query('UPDATE platform.messaging_participants SET removed_through_sequence=NULL WHERE conversation_id=$1 AND identity_id=$2 AND left_at IS NULL', [id, identityId]);
  return { inserted: false, conversation: await loadConversation(db, id), event: null };
}

export class PostgresMessagingRepository {
  #database;

  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL messaging repository requires transactions");
    this.#database = database;
  }

  async createConversation(value) {
    return this.#database.transaction(async (transaction) => {
      if (value.directKey) {
        const existing = rows(await transaction.query("SELECT id FROM platform.messaging_conversations WHERE direct_key=$1 FOR UPDATE", [Buffer.from(value.directKey.slice(7), "hex")]))[0];
        if (existing) return reopenConversation(transaction, existing.id, value.createdByIdentityId);
      }
      const inserted = rows(await transaction.query(`
        INSERT INTO platform.messaging_conversations (
          id,conversation_kind,title,team_key,direct_key,created_by_identity_id,
          last_message_sequence,revision,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (direct_key) DO NOTHING RETURNING id`, [
        value.id, value.kind, value.title, value.teamKey,
        value.directKey ? Buffer.from(value.directKey.slice(7), "hex") : null,
        value.createdByIdentityId, value.lastMessageSequence, value.revision, value.createdAt, value.updatedAt,
      ]));
      if (!inserted.length) {
        const existing = rows(await transaction.query("SELECT id FROM platform.messaging_conversations WHERE direct_key=$1 FOR UPDATE", [Buffer.from(value.directKey.slice(7), "hex")]))[0];
        return reopenConversation(transaction, existing.id, value.createdByIdentityId);
      }
      for (const item of value.participants) {
        await transaction.query(`
          INSERT INTO platform.messaging_participants (
            conversation_id,identity_id,participant_role,joined_at,left_at,last_read_sequence
          ) VALUES ($1,$2,$3,$4,$5,$6)`, [value.id, item.identityId, item.role, item.joinedAt, item.leftAt, item.lastReadSequence]);
      }
      const current = await loadConversation(transaction, value.id);
      const eventValue = await appendEvent(transaction, {
        type: "conversation.created", conversationId: value.id,
        audienceIdentityIds: current.participants.map((item) => item.identityId).sort(),
        authorIdentityId: value.createdByIdentityId, data: { kind: value.kind }, now: value.createdAt,
      });
      return { inserted: true, conversation: current, event: eventValue };
    });
  }

  async findConversationForMember(conversationId, identityId) {
    return loadConversation(this.#database, conversationId, identityId);
  }

  async listConversations(identityId, { after, limit }) {
    const ids = rows(await this.#database.query(`
      SELECT c.id, (SELECT count(*)::integer FROM platform.messaging_messages message
        WHERE message.conversation_id=c.id AND message.message_sequence>p.last_read_sequence
        AND ${visibleSql('message', 'p')}) AS unread_count FROM platform.messaging_conversations c
      JOIN platform.messaging_participants p ON p.conversation_id=c.id
      WHERE p.identity_id=$1 AND p.left_at IS NULL
        AND (p.removed_through_sequence IS NULL OR c.last_message_sequence>p.removed_through_sequence)
      ORDER BY c.updated_at DESC,c.id OFFSET $2 LIMIT $3`, [identityId, after, limit]));
    return Promise.all(ids.map(async row => ({ ...await loadConversation(this.#database, row.id), unreadCount: Number(row.unread_count ?? 0) })));
  }

  async addParticipant({ conversationId, identityId, role, now, actorIdentityId }) {
    return this.#database.transaction(async (transaction) => {
      const current = await loadConversation(transaction, conversationId, null, true);
      if (!current) return null;
      await transaction.query(`
        INSERT INTO platform.messaging_participants (
          conversation_id,identity_id,participant_role,joined_at,left_at,last_read_sequence
        ) VALUES ($1,$2,$3,$4,NULL,0)
        ON CONFLICT (conversation_id,identity_id) DO UPDATE
        SET participant_role=EXCLUDED.participant_role,joined_at=EXCLUDED.joined_at,left_at=NULL,last_read_sequence=0`, [conversationId, identityId, role, now]);
      await transaction.query("UPDATE platform.messaging_conversations SET revision=revision+1,updated_at=$2 WHERE id=$1", [conversationId, now]);
      const changed = await loadConversation(transaction, conversationId);
      const eventValue = await appendEvent(transaction, {
        type: "conversation.participant_added", conversationId,
        audienceIdentityIds: changed.participants.filter((item) => !item.leftAt).map((item) => item.identityId).sort(),
        authorIdentityId: actorIdentityId, data: { identityId, role }, now,
      });
      return { conversation: changed, event: eventValue };
    });
  }

  async insertMessage(value) {
    return this.#database.transaction(async (transaction) => {
      const current = await loadConversation(transaction, value.conversationId, value.authorIdentityId, true);
      if (!current) return null;
      const existing = rows(await transaction.query(`
        SELECT id FROM platform.messaging_messages
        WHERE conversation_id=$1 AND author_identity_id=$2 AND idempotency_key=$3 FOR UPDATE`, [value.conversationId, value.authorIdentityId, value.idempotencyKey]))[0];
      if (existing) return { inserted: false, message: await loadMessage(transaction, existing.id), event: null };
      if (value.replyToMessageId) {
        const reply = rows(await transaction.query("SELECT 1 FROM platform.messaging_messages WHERE id=$1 AND conversation_id=$2", [value.replyToMessageId, value.conversationId]))[0];
        if (!reply) throw new PlatformError("messaging_reply_invalid", "Reply target is unavailable", { status: 409 });
      }
      const sequence = Number(rows(await transaction.query(`
        UPDATE platform.messaging_conversations
        SET last_message_sequence=last_message_sequence+1,revision=revision+1,updated_at=$2
        WHERE id=$1 RETURNING last_message_sequence`, [value.conversationId, value.createdAt]))[0].last_message_sequence);
      await transaction.query(`
        INSERT INTO platform.messaging_messages (
          id,conversation_id,message_sequence,author_identity_id,author_kind,application_key,
          idempotency_key,request_digest,content,reply_to_message_id,created_at,edited_at,deleted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
        value.id, value.conversationId, sequence, value.authorIdentityId, value.authorKind, value.applicationKey,
        value.idempotencyKey, Buffer.from(value.requestDigest.slice(7), "hex"), value.content,
        value.replyToMessageId, value.createdAt, value.editedAt, value.deletedAt,
      ]);
      for (const [index, item] of value.attachments.entries()) {
        await transaction.query(`
          INSERT INTO platform.messaging_attachments (
            message_id,attachment_ordinal,object_id,object_version,filename,media_type,byte_size,sha256
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          value.id, index + 1, item.objectId, item.objectVersion, item.filename, item.mediaType,
          item.byteSize, Buffer.from(item.sha256.slice(7), "hex"),
        ]);
      }
      const recipients = current.participants.filter((item) => !item.leftAt);
      for (const item of recipients) {
        const own = item.identityId === value.authorIdentityId;
        await transaction.query(`
          INSERT INTO platform.messaging_delivery_receipts (
            message_id,identity_id,delivery_state,delivered_at,read_at,updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6)`, [value.id, item.identityId, own ? "read" : "queued", own ? value.createdAt : null, own ? value.createdAt : null, value.createdAt]);
        if (!own) await transaction.query(`
          INSERT INTO platform.messaging_notifications (
            identity_id,conversation_id,message_id,notification_kind,created_at
          ) VALUES ($1,$2,$3,'message',$4)`, [item.identityId, value.conversationId, value.id, value.createdAt]);
      }
      const stored = await loadMessage(transaction, value.id);
      const eventValue = await appendEvent(transaction, {
        type: "message.created", conversationId: value.conversationId, messageId: value.id,
        audienceIdentityIds: recipients.map((item) => item.identityId).sort(), authorIdentityId: value.authorIdentityId,
        data: { sequence, authorIdentityId: value.authorIdentityId }, now: value.createdAt,
      });
      return { inserted: true, message: stored, event: eventValue };
    });
  }

  async listMessages(conversationId, { after, before = null, limit, identityId = null }) {
    const ids = rows(await this.#database.query(`
      SELECT id FROM platform.messaging_messages message WHERE conversation_id=$1 AND message_sequence ${before === null ? ">" : "<"} $2
      ${identityId ? `AND EXISTS (SELECT 1 FROM platform.messaging_participants participant WHERE participant.conversation_id=message.conversation_id
        AND participant.identity_id=$4 AND participant.left_at IS NULL AND ${visibleSql()})` : ''}
      ORDER BY message_sequence ${before === null ? "ASC" : "DESC"} LIMIT $3`, [conversationId, before ?? after, limit, ...(identityId ? [identityId] : [])])).map((row) => row.id);
    if (before !== null) ids.reverse();
    return Promise.all(ids.map((id) => loadMessage(this.#database, id)));
  }

  async findAttachmentForMember(messageId, identityId, ordinal) {
    const value = rows(await this.#database.query(`
      SELECT attachment.* FROM platform.messaging_attachments attachment
      JOIN platform.messaging_messages message ON message.id=attachment.message_id
      JOIN platform.messaging_participants participant ON participant.conversation_id=message.conversation_id
      WHERE attachment.message_id=$1 AND attachment.attachment_ordinal=$3
        AND participant.identity_id=$2 AND participant.left_at IS NULL AND message.deleted_at IS NULL
        AND ${visibleSql()}`,
    [messageId, identityId, ordinal]))[0];
    return attachment(value);
  }

  async markDelivery({ messageId, identityId, state, now }) {
    return this.#database.transaction(async (transaction) => {
      const receiptRow = rows(await transaction.query(`
        SELECT receipt.*,message.conversation_id,message.message_sequence
        FROM platform.messaging_delivery_receipts receipt
        JOIN platform.messaging_messages message ON message.id=receipt.message_id
        JOIN platform.messaging_participants participant ON participant.conversation_id=message.conversation_id
          AND participant.identity_id=receipt.identity_id AND participant.left_at IS NULL
        WHERE receipt.message_id=$1 AND receipt.identity_id=$2 FOR UPDATE`, [messageId, identityId]))[0];
      if (!receiptRow) return null;
      const order = { queued: 0, delivered: 1, read: 2 };
      let cursorAdvanced = false;
      if (state === "read") {
        cursorAdvanced = rows(await transaction.query(`
          UPDATE platform.messaging_participants SET last_read_sequence=$3
          WHERE conversation_id=$1 AND identity_id=$2 AND left_at IS NULL AND last_read_sequence<$3
          RETURNING identity_id`, [receiptRow.conversation_id, identityId, Number(receiptRow.message_sequence)])).length > 0;
        await transaction.query(`
          UPDATE platform.messaging_notifications notification SET read_at=COALESCE(notification.read_at,$4)
          FROM platform.messaging_messages message
          WHERE notification.message_id=message.id AND notification.conversation_id=$1
            AND notification.identity_id=$2 AND message.message_sequence<=$3 AND notification.read_at IS NULL`,
        [receiptRow.conversation_id, identityId, Number(receiptRow.message_sequence), now]);
      }
      if (order[state] <= order[receiptRow.delivery_state] && !cursorAdvanced) return { message: await loadMessage(transaction, messageId), event: null };
      if (order[state] > order[receiptRow.delivery_state]) await transaction.query(`
        UPDATE platform.messaging_delivery_receipts
        SET delivery_state=$3,delivered_at=COALESCE(delivered_at,$4),read_at=CASE WHEN $3='read' THEN $4 ELSE NULL END,updated_at=$4
        WHERE message_id=$1 AND identity_id=$2`, [messageId, identityId, state, now]);
      const stored = await loadMessage(transaction, messageId);
      const eventValue = await appendEvent(transaction, {
        type: `message.${state}`, conversationId: receiptRow.conversation_id, messageId,
        audienceIdentityIds: await audience(transaction, receiptRow.conversation_id), authorIdentityId: identityId,
        data: { identityId, sequence: stored.sequence }, now,
      });
      return { message: stored, event: eventValue };
    });
  }

  async searchMessages(identityId, { query, conversationId, limit, beforeTime = null, beforeId = null }) {
    const ids = rows(await this.#database.query(`
      SELECT DISTINCT message.id,message.created_at FROM platform.messaging_messages message
      JOIN platform.messaging_participants participant ON participant.conversation_id=message.conversation_id
      LEFT JOIN platform.messaging_attachments attachment ON attachment.message_id=message.id
      WHERE participant.identity_id=$1 AND participant.left_at IS NULL AND message.deleted_at IS NULL
        AND ${visibleSql()}
        AND ($2::uuid IS NULL OR message.conversation_id=$2)
        AND (position(lower($3) in lower(message.content))>0 OR position(lower($3) in lower(COALESCE(attachment.filename,'')))>0)
        AND ($5::timestamptz IS NULL OR message.created_at<$5 OR (message.created_at=$5 AND message.id>$6::uuid))
      ORDER BY message.created_at DESC,message.id LIMIT $4`, [identityId, conversationId, query, limit, beforeTime, beforeId])).map((row) => row.id);
    return Promise.all(ids.map((id) => loadMessage(this.#database, id)));
  }

  async listNotifications(identityId, { unreadOnly, limit, beforeTime = null, beforeId = null }) {
    return rows(await this.#database.query(`
      SELECT * FROM platform.messaging_notifications notification
      WHERE identity_id=$1 AND ($2::boolean=false OR read_at IS NULL)
        AND EXISTS (SELECT 1 FROM platform.messaging_messages message
          JOIN platform.messaging_participants participant ON participant.conversation_id=message.conversation_id
          WHERE message.id=notification.message_id AND participant.identity_id=$1 AND participant.left_at IS NULL
          AND ${visibleSql()})
        AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND id>$5::uuid))
      ORDER BY created_at DESC,id LIMIT $3`, [identityId, unreadOnly, limit, beforeTime, beforeId])).map(notification);
  }

  async markNotificationRead(notificationId, identityId, now) {
    return notification(rows(await this.#database.query(`
      UPDATE platform.messaging_notifications SET read_at=COALESCE(read_at,$3)
      WHERE id=$1 AND identity_id=$2 RETURNING *`, [notificationId, identityId, now]))[0]);
  }

  async cleanup({ conversationId, identityId, action, throughSequence, messageId, now }) {
    return this.#database.transaction(async db => {
      // Same lock as insertMessage: a cutoff never consumes a concurrently arriving newer message.
      const current = await loadConversation(db, conversationId, identityId, true);
      if (!current) return null;
      if (action === 'message') {
        const target = rows(await db.query('SELECT id FROM platform.messaging_messages WHERE id=$1 AND conversation_id=$2', [messageId, conversationId]))[0];
        if (!target) return null;
        await db.query(`INSERT INTO platform.messaging_hidden_messages(message_id,identity_id,hidden_at)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [messageId, identityId, now]);
      } else {
        if (throughSequence > current.lastMessageSequence) throw new PlatformError('messaging_cursor_invalid', 'Cleanup cursor is invalid', { status: 400 });
        await db.query(`UPDATE platform.messaging_participants SET
          cleared_through_sequence=GREATEST(cleared_through_sequence,$3),
          last_read_sequence=GREATEST(last_read_sequence,$3),
          removed_through_sequence=CASE WHEN $4='remove' THEN GREATEST(COALESCE(removed_through_sequence,0),$3) ELSE removed_through_sequence END
          WHERE conversation_id=$1 AND identity_id=$2`, [conversationId, identityId, throughSequence, action]);
      }
      return { event: await appendEvent(db, { type: 'conversation.cleaned', conversationId,
        audienceIdentityIds: [identityId], authorIdentityId: identityId, data: { action, messageId, throughSequence }, now }) };
    });
  }

  async setPresence({ identityId, state, connectionId, ttlSeconds, now }) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("DELETE FROM platform.messaging_presence_connections WHERE identity_id=$1 AND expires_at<=$2", [identityId, now]);
      if (state === "offline") {
        await transaction.query("DELETE FROM platform.messaging_presence_connections WHERE identity_id=$1 AND connection_id=$2", [identityId, connectionId]);
      } else {
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
        await transaction.query(`
          INSERT INTO platform.messaging_presence_connections (identity_id,connection_id,presence_state,last_seen_at,expires_at)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (identity_id,connection_id) DO UPDATE
          SET presence_state=EXCLUDED.presence_state,last_seen_at=EXCLUDED.last_seen_at,expires_at=EXCLUDED.expires_at`, [identityId, connectionId, state, now, expiresAt]);
      }
      const aggregate = rows(await transaction.query(`
        SELECT count(*)::integer AS connection_count,
               CASE WHEN bool_or(presence_state='online') THEN 'online' ELSE 'away' END AS presence_state,
               max(expires_at) AS expires_at
        FROM platform.messaging_presence_connections WHERE identity_id=$1`, [identityId]))[0];
      const count = Number(aggregate.connection_count);
      const effective = count === 0 ? "offline" : aggregate.presence_state;
      return presence(rows(await transaction.query(`
        INSERT INTO platform.messaging_presence (identity_id,presence_state,connection_count,last_seen_at,expires_at,revision)
        VALUES ($1,$2,$3,$4,$5,1)
        ON CONFLICT (identity_id) DO UPDATE
        SET presence_state=EXCLUDED.presence_state,connection_count=EXCLUDED.connection_count,
            last_seen_at=EXCLUDED.last_seen_at,expires_at=EXCLUDED.expires_at,revision=platform.messaging_presence.revision+1
        RETURNING *`, [identityId, effective, count, now, count === 0 ? null : aggregate.expires_at]))[0]);
    });
  }

  async getPresence(requesterIdentityId, identityIds, now) {
    const shared = rows(await this.#database.query(`
      SELECT DISTINCT requested.identity_id
      FROM unnest($2::uuid[]) AS requested(identity_id)
      WHERE requested.identity_id=$1 OR EXISTS (
        SELECT 1 FROM platform.messaging_participants self
        JOIN platform.messaging_participants peer ON peer.conversation_id=self.conversation_id
        WHERE self.identity_id=$1 AND self.left_at IS NULL AND peer.identity_id=requested.identity_id AND peer.left_at IS NULL
      )`, [requesterIdentityId, identityIds])).map((row) => row.identity_id);
    if (!shared.length) return [];
    const values = rows(await this.#database.query("SELECT * FROM platform.messaging_presence WHERE identity_id=ANY($1::uuid[])", [shared])).map(presence);
    const indexed = new Map(values.map((value) => [value.identityId, value]));
    return shared.map((identityId) => {
      const current = indexed.get(identityId);
      if (!current || (current.expiresAt && current.expiresAt <= now)) return { identityId, state: "offline", connectionCount: 0, lastSeenAt: current?.lastSeenAt ?? now, expiresAt: null, revision: current?.revision ?? 0 };
      return current;
    });
  }

  async listEvents(identityId, { after, limit }) {
    return rows(await this.#database.query(`
      SELECT * FROM platform.messaging_events
      WHERE sequence_id>$2 AND $1=ANY(audience_identity_ids)
      ORDER BY sequence_id LIMIT $3`, [identityId, after, limit])).map(event);
  }

  async findEvent(eventId) {
    return event(rows(await this.#database.query("SELECT * FROM platform.messaging_events WHERE event_id=$1", [eventId]))[0]);
  }
}
