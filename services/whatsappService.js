/** WhatsApp Business API stub — only active when WHATSAPP_ENABLED=true. */

function isWhatsAppEnabled() {
  return (
    process.env.WHATSAPP_ENABLED === "true" &&
    Boolean(process.env.WHATSAPP_API_URL) &&
    Boolean(process.env.WHATSAPP_TOKEN)
  );
}

async function sendTemplateMessage({ to, templateName, variables = {} }) {
  if (!isWhatsAppEnabled()) {
    return { sent: false, reason: "whatsapp_disabled" };
  }

  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_TOKEN;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        template: templateName,
        variables,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { sent: false, reason: text.slice(0, 200) };
    }

    const data = await res.json().catch(() => ({}));
    return { sent: true, messageId: data.messageId || data.id || null };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  isWhatsAppEnabled,
  sendTemplateMessage,
};
