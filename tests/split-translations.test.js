const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitTranslations, parseCsv, toCsv } = require('../scripts/split-translations');

const good = {
    Hindi: { question: 'प्रश्न?', options: ['क', '', 'ख'], answer: 'B) ख', explanation: '(\\^^ हिंदी व्याख्या जो काफी लंबी है। ^^\\)' },
    Telugu: { question: 'ప్రశ్న?', options: [], answer: 'B) ఖ', explanation: '(\\^^ తెలుగు వివరణ చాలా పొడవుగా ఉంది. ^^\\)' },
    English: { answer: 'B) Two', question: 'Question?' },
    Tamil: { question: 'கேள்வி', answer: 'B)', explanation: 'விளக்கம்' }
};

function csv(rows) {
    return toCsv([['ID', 'Explanations', 'Translations'], ...rows.map(([id, translations]) =>
        [id, '(\\^^ An English explanation of similar length. ^^\\)', JSON.stringify(translations)])]);
}

test('splits Hindi and Telugu into import columns and ignores other languages', () => {
    const { importRows, heldRows, summary } = splitTranslations(csv([['q1', good]]));
    const [header, row] = importRows;
    assert.deepEqual(header, ['ID', 'Explanations',
        'Hindi Question', 'Hindi Options', 'Hindi Answer', 'Hindi Explanation',
        'Telugu Question', 'Telugu Options', 'Telugu Answer', 'Telugu Explanation']);
    const value = name => row[header.indexOf(name)];
    assert.equal(value('Hindi Options'), 'क | ख');
    assert.equal(value('Hindi Answer'), 'B) ख');
    assert.equal(value('Telugu Options'), '');
    assert.equal(value('Telugu Question'), 'ప్రశ్న?');
    assert.equal(header.some(name => name.startsWith('Tamil') || name.startsWith('English')), false);
    assert.deepEqual(summary, { questions: 1, ready: 2, held: 0 });
    assert.equal(heldRows.length, 1);
});

test('holds scrambled translations and leaves their import cells blank', () => {
    const scrambled = {
        Hindi: { question: 'यदि x² के शून्य α और β हैं', answer: 'तो α+β का मान क्या है?', explanation: '(\\^^ A) 9 ^^\\)' },
        Telugu: { question: 'हिंदी पाठ', answer: 'B) ఖ', explanation: '(\\^^ తెలుగు వివరణ చాలా పొడవుగా ఉంది. ^^\\)' },
        English: { answer: 'A) 9' }
    };
    const { importRows, heldRows, summary } = splitTranslations(csv([['q2', scrambled]]));
    assert.deepEqual(importRows[1].slice(2), Array(8).fill(''));
    assert.deepEqual(summary, { questions: 1, ready: 0, held: 2 });
    const reasons = Object.fromEntries(heldRows.slice(1).map(([, language, why]) => [language, why]));
    assert.match(reasons.Hindi, /Answer looks like part of the question/);
    assert.match(reasons.Hindi, /Explanation is just an option/);
    assert.match(reasons.Hindi, /cut off/);
    assert.match(reasons.Telugu, /Question is in the wrong language/);
});

test('an English answer that is itself a question is not held', () => {
    const englishQuestion = {
        Hindi: { question: 'आप क्या कहेंगे?', answer: 'B) Can I borrow your book?', explanation: '(\\^^ यह किताब माँगने का विनम्र तरीका है। ^^\\)' },
        English: { answer: 'B) Can I borrow your book?' }
    };
    const { summary } = splitTranslations(csv([['q3', englishQuestion]]));
    assert.deepEqual(summary, { questions: 1, ready: 1, held: 0 });
});

test('invalid JSON is held and a file without a Translations column is rejected', () => {
    const { heldRows } = splitTranslations('ID,Translations\nq4,{not json\n');
    assert.equal(heldRows[1][2], 'Translations cell is not valid JSON');
    assert.throws(() => splitTranslations('ID,Explanations\nq5,x\n'), /ID and Translations/);
});

test('CSV helpers round-trip quotes, commas and new lines', () => {
    const rows = [['a,b', 'say "hi"', 'line\nbreak']];
    assert.deepEqual(parseCsv(toCsv(rows).trimEnd()), rows);
});
