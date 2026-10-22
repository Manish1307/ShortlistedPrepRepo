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

/**
 * The customer's focus, set in the admin dashboard (Topics and resume) and sent to ShortlistPrep.AI with the licence:
 * the topics questions are about, and (for answers) the resume of the person being helped. Lines to put after the
 * subject; none when nothing is set.
 */
const RESUME_CHARS = 6000;
function formatProfile(profile, { resume = true } = {}) {
  const topics = profile && Array.isArray(profile.topics) ? profile.topics.filter(Boolean) : [];
  const cv = resume && profile && profile.resume ? String(profile.resume).trim() : '';
  const out = [];
  if (topics.length) out.push(`Topics to focus on (questions are expected to be about these areas): ${topics.join('; ')}`);
  if (cv) {
    out.push('Background of the person you are helping, from their resume (use it to choose the area, technologies and examples that fit their experience; do not quote it):',
      cv.length > RESUME_CHARS ? cv.slice(0, RESUME_CHARS) + '…' : cv);
  }
  return out;
}

function buildExtractMessage({ subject, context, text, previous, profile }) {
  const lines = (context || []).map(l => `- ${l}`).join('\n') || '- (nothing yet)';
  return [
    `Subject of this class: ${subject || '(not specified)'}`,
    ...formatProfile(profile, { resume: false }),
    '',
    'Recent class speech for context (oldest first):',
    lines,
    '',
    ...((previous && previous.length) ? ['Earlier questions in this class and the answers given (a new question may be a follow-up to these):', formatPrevious(previous, 200), ''] : []),
    'NEW speech:',
    text,
  ].join('\n');
}

// Screen capture: the teacher captured part of the screen where a student's question is shown (an image the student
// sent, Notepad, the meeting chat, a document). The AI copies the question(s) out of the picture; they are then
// answered exactly like spoken questions.
const SCREEN_PROMPT = `You help a teacher who is running a live online class. The teacher captured part of the screen that shows a question a student shared: a picture, a Notepad file, a chat message, a document or a slide.

Read the screenshot and copy out every question, exercise or task in it, each as one complete, standalone question.
Rules:
- Copy the wording faithfully. Keep everything needed to answer it: given values, conditions, answer options (A, B, C, D), table data, and any code exactly as written, line breaks and indentation included.
- If code or an error message is shown with a request ("fix this", "why does this fail", "what is the output"), make that the question and include the code or the error in it. If only code or an error is shown, ask what a student would want: what is wrong with it and how to fix it, or what it does.
- Fix only obvious reading mistakes. Do not answer anything.
- Ignore everything around the question: menus, toolbars, window titles, the taskbar, names, times, emojis, and chat messages that are not questions.
- If there are several separate questions, list each one, in the order shown.

Reply with ONLY a JSON array of strings, for example ["What is the output of this Python code?\\nfor i in range(3):\\n    print(i)"]. Reply [] if there is no question in the picture.`;

function buildScreenMessage({ subject, previous, profile }) {
  return [
    `Subject of this class: ${subject || '(not specified)'}`,
    ...formatProfile(profile, { resume: false }),
    ...((previous && previous.length) ? ['', 'Earlier questions in this class (the new one may follow on from these):', formatPrevious(previous, 200)] : []),
    '',
    'Copy out the question(s) shown in the screenshot.',
  ].join('\n');
}

module.exports = { EXTRACT_PROMPT, SCREEN_PROMPT, parseQuestionList, buildExtractMessage, buildScreenMessage, formatPrevious, formatProfile };
