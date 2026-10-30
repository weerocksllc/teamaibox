export function conversationPreview(conversation, latest, translate) {
  if (latest?.content) return latest.content;
  if (latest?.attachments?.length) return translate('attachment');
  return Number(conversation?.last_message_sequence ?? conversation?.lastMessageSequence ?? 0) > 0
    ? translate('openMessages') : translate('noMessages');
}
