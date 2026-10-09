'use strict';
// Sends a detected question (plus the recent class transcript) to Claude and streams the answer back.
// Runs in the Electron main process only: the API key never reaches the web pages.

const Anthropic = require('@anthropic-ai/sdk');
const { EXTRACT_PROMPT, parseQuestionList, buildExtractMessage, formatPrevious } = require('./framing');

const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM_PROMPT = `You are a private, real-time assistant for a teacher who is running a live online class. Only the teacher can see your reply; the students cannot.

You receive (1) the subject of the class, (2) the most recent part of the class transcript, produced by automatic speech recognition, so it can contain mistakes, and (3) a question that was just asked, by a student or by the teacher.

First decide whether the text is a real question or request for explanation that has an answer. If it is only classroom logistics (can you hear me, screen sharing, muting, breaks, greetings) or small talk, reply with exactly: SKIP

If the question just asked is a follow-up to an earlier question ("what about…", "show that in code", "and the second step?"), use the earlier questions and answers listed for you: refer back to them, stay consistent with them, and build on them instead of repeating them. Do not answer the earlier questions again.

Answer ONLY the question under "Question just asked". It can be a scenario spread over several sentences (a situation, then what is wanted): answer what is actually being asked, using the whole scenario, and cover each part that was asked for (for example every step, or both the set-up and the code). Lines in the transcript may contain earlier questions: those were already answered, so never answer them again; use them only as background.

Otherwise write the answer exactly as a person would say it out loud, so the teacher can read it straight to the class:
- Speak in the first person, like a real teacher or colleague explaining to a friend: natural, warm, confident. Never mention that you are an AI, never use phrases like "Certainly!", "Great question", "As an AI".
- Use easy, everyday words and short sentences. Explain it so a beginner understands on the first hearing. If you must use a technical term, say what it means in plain words straight away.
- Start with the direct answer in the first sentence, then explain it step by step in simple language. Use a small real-life example or comparison whenever the idea is abstract or technical.
- Usually 80 to 160 words; go longer only when the question asks for several steps or code. Write ONE short statement per line, at most about 18 words each, so the teacher can read a line, pause, then read the next. Never write a paragraph, and never a long sentence with several clauses: split it into separate lines. A few "-" bullet points or numbered steps are fine for a sequence of steps, but never headings, bold or other markdown. Write maths simply (x^2, sqrt(x), a/b); keep code short and plain.
- Finish when the explanation is complete. Do NOT end with an offer, a suggestion or a question: never write things like "let me know if...", "would you like me to...", "feel free to ask", "do you want more detail", "I hope this helps", and do not suggest what to ask next. Do not ask the user any question at all. If something is unclear, make the most sensible assumption, say so in one short sentence, and answer.
- Accuracy matters more than sounding confident: think the question through, check names, numbers and facts, and answer what was actually asked. If you are not sure of something, say so briefly instead of guessing.
- Use the subject and the transcript only to correct obvious recognition mistakes (e.g. "dot net" is .NET). When a term has several meanings (for example "enable an API" can mean the Dataverse/Power Pages Web API, a custom connector, or an Azure API), pick the meaning that fits the subject of the class; if the subject does not settle it, answer the most likely meaning and add one short sentence naming the other.`;

/** `effort` is accepted by Opus / Sonnet / Fable models, not by Haiku. */
const supportsEffort = model => /^claude-(opus|sonnet|fable)-\d/.test(model);
/** Refusal fallbacks are offered for the current Opus / Sonnet / Fable models. */
const supportsFallback = model => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);


/** Quick mode asks for a shorter spoken answer: fewer words are written, so it is finished sooner. */
const systemPromptFor = effort => (effort === 'low'
  ? SYSTEM_PROMPT.replace('Usually 80 to 160 words; go longer only when the question asks for several steps or code.',
    'Keep it short, about 50 to 90 words, because the teacher is live and needs it fast; go longer only when the question asks for several steps or code.')
  : SYSTEM_PROMPT);

/**
 * Safety net: if the AI still ends with an offer or a question to the teacher ("Let me know if...", "Would you like...?",
 * "Hope this helps!"), cut those closing sentences off. Never touches the body of the answer.
 */
const CLOSING_OFFER = /^(let me know|feel free|would you like|do you want|want me to|shall i|should i|if you (want|need|would like|have|'d like)|i hope|hope (this|that)|happy to|is there anything|any (other|more) questions|just ask|don't hesitate)/i;
function cleanAnswer(text) {
  let out = String(text || '').trim();
  for (let round = 0; round < 4; round++) {
    // find where the last sentence (or line) starts
    const boundary = /(?<=[.!?])[ \t]+|\n+/g;
    let lastStart = -1, lastEnd = -1, m;
    while ((m = boundary.exec(out))) { lastStart = m.index; lastEnd = m.index + m[0].length; }
    if (lastEnd <= 0) break;
    const tail = out.slice(lastEnd).trim();
    const isOffer = CLOSING_OFFER.test(tail) || (tail.endsWith('?') && tail.length < 120);   // a closing offer or a question back
    if (!isOffer) break;
    out = out.slice(0, lastStart).trimEnd();
  }
  return out;
}

function buildUserMessage({ subject, context, question, previous }) {
  const lines = (context || []).map(l => `- ${l}`).join('\n') || '- (nothing yet)';
  return [
    `Subject of this class: ${subject || '(not specified)'}`,
    '',
    'Recent class transcript (oldest first):',
    lines,
    '',
    ...((previous && previous.length) ? ['Earlier questions in this class and the answers you gave (oldest first):', formatPrevious(previous, 700), ''] : []),
    'Question just asked:',
    question,
  ].join('\n');
}

class Answerer {
  constructor({ apiKey = '', model = DEFAULT_MODEL, effort = 'low', subject = '', useFallback = true } = {}) {
    this.model = model;
    this.effort = effort;
    this.subject = subject;
    this.useFallback = useFallback;
    this.fallbackRejected = false;
    this.setApiKey(apiKey);
  }

  setApiKey(apiKey) {
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 2 }) : null;
  }
  setModel(model) { this.model = model || DEFAULT_MODEL; this.fallbackRejected = false; }
  setSubject(subject) { this.subject = subject || ''; }
  get ready() { return !!this.client; }

  /** "Test connection": does a tiny question work with the selected model? */
  async diagnose() {
    if (!this.client) return ['No Anthropic key is saved yet. Paste it above and press Save first.'];
    try {
      await this.client.messages.create({ model: this.model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
      return ['✓ ' + this.model + ' works.'];
    } catch (err) {
      return ['✗ ' + this.model + ': ' + (err && err.message ? err.message : err)];
    }
  }

  /** Turn newly heard speech into a list of clear, standalone questions (may be empty). */
  async extractQuestions({ text, context = [], previous = [], signal } = {}) {
    if (!this.client) throw Object.assign(new Error('No Anthropic API key set'), { code: 'no-key' });
    const message = await this.client.messages.create({
      model: this.model, max_tokens: 600, system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: buildExtractMessage({ subject: this.subject, context, text, previous }) }],
    }, { signal });
    return parseQuestionList(message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  }

  _params(question, context, previous) {
    const params = {
      model: this.model,
      max_tokens: 4096, // thinking tokens count towards this, so leave plenty of room
      system: systemPromptFor(this.effort),
      messages: [{ role: 'user', content: buildUserMessage({ subject: this.subject, context, question, previous }) }],
    };
    if (supportsEffort(this.model)) params.output_config = { effort: this.effort };
    return params;
  }

  _stream(params, signal, withFallback) {
    if (withFallback) {
      return this.client.beta.messages.stream(
        { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' },
        { signal },
      );
    }
    return this.client.messages.stream(params, { signal });
  }

  /**
   * @returns {Promise<{text: string, skipped: boolean, refused: boolean}>}
   * Text is delivered through onDelta as it is generated. A reply of "SKIP" is never shown.
   */
  async answer({ question, context = [], previous = [], onDelta = () => {}, signal } = {}) {
    if (!this.client) throw Object.assign(new Error('No Anthropic API key set'), { code: 'no-key' });
    const params = this._params(question, context, previous);

    let text = '';
    let held = '';       // first few characters are held back until we know the reply is not "SKIP"
    let decided = false; // true once we know whether to show the reply
    let skipped = false;
    const emit = chunk => { text += chunk; onDelta(chunk); };
    const onText = delta => {
      if (decided) { if (!skipped) emit(delta); return; }
      held += delta;
      if (held.trim().length >= 4) {
        decided = true;
        if (/^\s*SKIP/i.test(held)) skipped = true; else emit(held);
      }
    };

    const run = async withFallback => {
      const stream = this._stream(params, signal, withFallback);
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
      }
      return stream.finalMessage();
    };

    const wantFallback = this.useFallback && supportsFallback(this.model) && !this.fallbackRejected;
    let message;
    try {
      message = await run(wantFallback);
    } catch (err) {
      // If the API rejects the fallback option, remember it and retry once without it.
      if (wantFallback && err instanceof Anthropic.BadRequestError && !text && !held) {
        this.fallbackRejected = true;
        message = await run(false);
      } else {
        throw err;
      }
    }

    if (!decided && held) { // very short reply: decide now
      if (/^\s*SKIP\s*$/i.test(held)) skipped = true; else emit(held);
    }
    if (message.stop_reason === 'refusal') return { text: '', skipped: false, refused: true };
    return { text: cleanAnswer(text), skipped, refused: false };
  }
}

module.exports = { systemPromptFor, cleanAnswer, Answerer, DEFAULT_MODEL, SYSTEM_PROMPT, buildUserMessage, supportsEffort, supportsFallback };
