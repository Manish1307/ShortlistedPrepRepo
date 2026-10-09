'use strict';
// Step 1 of answering: the AI reads the newly heard speech, finds every question in it, and words each one as a
// clear, standalone question. (Step 2 answers each of those questions. See answerer.js / gemini.js.)

const EXTRACT_PROMPT = `You help a teacher who is running a live online class. You receive (1) the subject of the class, (2) recent class speech for context, and (3) the NEW speech that was just heard. All of it was produced by automatic speech recognition, so it can contain mistakes.

Find every question or request for explanation in the NEW speech and write each one as a complete, clear, standalone question. There may be several, and a single question is often spread over several sentences: a situation or scenario first, the actual request next, and a closing line like "could you please explain this to me?". Combine those sentences into ONE question that keeps every detail needed to answer it (the steps asked for, the technologies and names, the conditions of the scenario). Never output a vague question such as "explain this": say what "this" is.
Rules:
- Fix obvious recognition mistakes using the subject and the context.
- If a question depends on earlier speech or on an earlier question and answer ("what about its derivative?", "can you show that in code?", "and the second step?"), rewrite it so it makes sense on its own, naming the thing it refers to.
- Drop filler ("my question is", "another question", "can you tell me") but keep the meaning exactly.
- Ignore classroom logistics (can you hear me, screen sharing, breaks), greetings and small talk.
- Keep the questions in the order they were asked.

Reply with ONLY a JSON array of strings, for example ["What is a web service in .NET?","What is the difference between an API and a web service?"]. Reply [] if there is no question.`;

/** Pull the list of questions out of a model reply (tolerates code fences and extra words). null = unusable reply. */
function parseQuestionList(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const list = JSON.parse(m[0]);
    if (!Array.isArray(list)) return null;
    return list.map(q => String(q).trim()).filter(q => q.length > 3).slice(0, 5);
  } catch (_) { return null; }
}

/** The last few questions and answers of this class, so follow-up questions can be understood. */
function formatPrevious(previous, answerChars = 500) {
  return (previous || []).map((p, i) => {
    const answer = String(p.answer || '').replace(/\s+/g, ' ').trim();
    return `${i + 1}. Q: ${p.question}\n   A: ${answer.length > answerChars ? answer.slice(0, answerChars) + '…' : answer}`;
  }).join('\n');
}

function buildExtractMessage({ subject, context, text, previous }) {
  const lines = (context || []).map(l => `- ${l}`).join('\n') || '- (nothing yet)';
  return [
    `Subject of this class: ${subject || '(not specified)'}`,
    '',
    'Recent class speech for context (oldest first):',
    lines,
    '',
    ...((previous && previous.length) ? ['Earlier questions in this class and the answers given (a new question may be a follow-up to these):', formatPrevious(previous, 200), ''] : []),
    'NEW speech:',
    text,
  ].join('\n');
}

module.exports = { EXTRACT_PROMPT, parseQuestionList, buildExtractMessage, formatPrevious };
