/**
 * Client email intent library — rule-based detection with confidence scores.
 * Low-confidence replies should go to Exception Center, not auto-action.
 */
const CLIENT_INTENTS = [
  {
    id: "book_site_visit",
    label: "Book site visit",
    patterns: [
      /\bsite visit\b/i,
      /\bbook\s+(a\s+)?visit\b/i,
      /\bschedule\s+(a\s+)?visit\b/i,
      /\bvisit\s+(the\s+)?property\b/i,
      /\bkal\s+visit\b/i,
      /\bvisit\s+kar/i,
    ],
    workflow: "propose_site_visit",
    minConfidence: 0.72,
  },
  {
    id: "request_call",
    label: "Request call",
    patterns: [
      /\bcall\s+me\b/i,
      /\bplease\s+call\b/i,
      /\bgive\s+(me\s+)?a\s+call\b/i,
      /\bphone\s+(me|kar)/i,
      /\bcontact\s+me\b/i,
      /\bmy\s+number\b/i,
    ],
    workflow: "create_call_task",
    minConfidence: 0.7,
  },
  {
    id: "want_another_option",
    label: "Want another property option",
    patterns: [
      /\boption\s*#?\s*(\d+)\b/i,
      /\b(\d+)\s*(st|nd|rd|th)\s+option\b/i,
      /\banother\s+(property|option)\b/i,
      /\bother\s+(property|option)\b/i,
      /\bdifferent\s+property\b/i,
      /\bsecond\s+property\b/i,
      /\bsend\s+option\s*(\d+)\b/i,
    ],
    workflow: "link_alternate_property",
    minConfidence: 0.68,
    extractOptionNumber: true,
  },
  {
    id: "want_cheaper",
    label: "Want cheaper option",
    patterns: [
      /\bcheaper\b/i,
      /\blower\s+rent\b/i,
      /\breduce\s+(the\s+)?rent\b/i,
      /\bbudget\s+is\s+low\b/i,
      /\btoo\s+expensive\b/i,
    ],
    workflow: "rematch_cheaper",
    minConfidence: 0.65,
  },
  {
    id: "not_interested",
    label: "Not interested",
    patterns: [
      /\bnot\s+interested\b/i,
      /\bno\s+longer\s+interested\b/i,
      /\bnot\s+looking\b/i,
      /\bplans?\s+changed\b/i,
      /\bstop\s+(mailing|email)/i,
    ],
    workflow: "propose_close",
    minConfidence: 0.75,
  },
  {
    id: "need_documents",
    label: "Need documents",
    patterns: [
      /\bdocument/i,
      /\bfloor\s+plan/i,
      /\bbrochure\b/i,
      /\bgst\s+invoice\b/i,
      /\blegal\s+paper/i,
      /\barchitect\b/i,
    ],
    workflow: "create_document_task",
    minConfidence: 0.6,
  },
  {
    id: "thanks_ack",
    label: "Thank you / acknowledgment",
    patterns: [/^\s*thanks?\b/i, /\bthank\s+you\b/i, /\bnoted\b/i, /\bok\b/i, /\bgot\s+it\b/i],
    workflow: "ack_only",
    minConfidence: 0.55,
  },
];

const REVIEW_THRESHOLD = 0.65;

module.exports = {
  CLIENT_INTENTS,
  REVIEW_THRESHOLD,
};
