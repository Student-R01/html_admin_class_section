#!/usr/bin/env node
// Converts a question CSV whose `Translations` column holds JSON (as in the Questions export) into the
// per-language columns the Questions page imports: "Hindi Question", "Hindi Options", ... "Telugu Explanation".
// Entries that look scrambled are left blank in the import file (so the import keeps what is stored) and
// listed in a separate "held" file for review.
//
// Usage: node scripts/split-translations.js <input.csv> [output-folder]
const fs = require('node:fs');
const path = require('node:path');

// Must match TRANSLATION_LANGUAGES in questions.js, which decides which columns the import reads.
const LANGUAGES = ['Hindi', 'Telugu'];
const FIELDS = [
    ['question', 'Question'],
    ['options', 'Options'],
    ['answer', 'Answer'],
    ['explanation', 'Explanation']
];
const SCRIPTS = { Hindi: /[ऀ-ॿ]/, Telugu: /[ఀ-౿]/ };
const OPTION_LETTER = /^\s*[A-D]\)/;

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let inQuotes = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (char === '"' && inQuotes && next === '"') {
            value += '"';
            index += 1;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            row.push(value);
            value = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') index += 1;
            row.push(value);
            rows.push(row);
            row = [];
            value = '';
        } else {
            value += char;
        }
    }
    row.push(value);
    if (row.length > 1 || row[0]) rows.push(row);
    return rows;
}

function toCsv(rows) {
    return rows.map(row => row.map(value => {
        const text = String(value ?? '');
        return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    }).join(',')).join('\n') + '\n';
}

function text(value) {
    return Array.isArray(value) ? value.map(text).join(' ') : String(value ?? '').trim();
}

// Drops the "(\^^ ... ^^\)" wrapper and segment markers so explanation lengths compare fairly.
function plainExplanation(value) {
    return text(value).replace(/\(?\\*\^\^\\*\)?/g, ' ').replace(/\s+/g, ' ').trim();
}

// Reasons a translation looks scrambled, such as fields shifted after a comma split. Empty means it is usable.
function translationProblems(language, entry, englishExplanation, englishAnswer) {
    const problems = [];
    const otherScripts = Object.entries(SCRIPTS).filter(([name]) => name !== language).map(([, script]) => script);
    for (const [key, label] of FIELDS) {
        if (otherScripts.some(script => script.test(text(entry[key])))) problems.push(`${label} is in the wrong language`);
    }
    const question = text(entry.question ?? entry.prompt);
    const answer = text(entry.answer ?? entry.correctAnswer);
    const explanation = plainExplanation(entry.explanation);
    const reference = plainExplanation(englishExplanation);
    if (!question) problems.push('Question is blank');
    if (!answer) problems.push('Answer is blank');
    if (/[??]$/.test(answer) && !/[??]$/.test(englishAnswer)) problems.push('Answer looks like part of the question');
    if (OPTION_LETTER.test(englishAnswer) && !OPTION_LETTER.test(answer)) problems.push('Answer has no option letter');
    if (!explanation) {
        problems.push('Explanation is blank');
    } else {
        if (OPTION_LETTER.test(explanation) && explanation.length < 40) problems.push('Explanation is just an option');
        if (/[??]$/.test(explanation)) problems.push('Explanation looks like part of the question');
        if (reference && explanation.length < 0.3 * reference.length) problems.push('Explanation is much shorter than the English one');
    }
    if (language === 'Hindi' && question.startsWith('यदि') && !question.includes('तो')) {
        problems.push('Question is cut off ("यदि" without "तो")');
    }
    return [...new Set(problems)];
}

function columnIndex(headers, name) {
    return headers.findIndex(header => header.trim().toLowerCase() === name);
}

// Returns { importRows, heldRows, summary }. Rows are arrays ready for toCsv, header first.
function splitTranslations(csvText) {
    const [headers = [], ...rows] = parseCsv(csvText.replace(/^﻿/, ''));
    const idIndex = columnIndex(headers, 'id');
    const translationsIndex = columnIndex(headers, 'translations');
    if (idIndex === -1 || translationsIndex === -1) throw new Error('The CSV needs ID and Translations columns.');
    let explanationIndex = columnIndex(headers, 'explanations');
    if (explanationIndex === -1) explanationIndex = columnIndex(headers, 'explanation');

    const importHeader = ['ID'];
    if (explanationIndex !== -1) importHeader.push('Explanations');
    for (const language of LANGUAGES) for (const [, label] of FIELDS) importHeader.push(`${language} ${label}`);
    const importRows = [importHeader];
    const heldRows = [['ID', 'Language', 'Why held', 'Translation as given']];
    const summary = { questions: 0, ready: 0, held: 0 };

    for (const row of rows) {
        const id = text(row[idIndex]);
        if (!id) continue;
        summary.questions += 1;
        const englishExplanation = explanationIndex === -1 ? '' : row[explanationIndex] ?? '';
        let translations = {};
        try {
            translations = JSON.parse(row[translationsIndex] || '{}') || {};
        } catch {
            heldRows.push([id, 'All', 'Translations cell is not valid JSON', row[translationsIndex]]);
        }
        const englishAnswer = text(translations.English?.answer);
        const out = [id];
        if (explanationIndex !== -1) out.push(englishExplanation);
        for (const language of LANGUAGES) {
            const entry = translations[language];
            const problems = entry && typeof entry === 'object'
                ? translationProblems(language, entry, englishExplanation, englishAnswer)
                : null;
            if (problems?.length) {
                summary.held += 1;
                heldRows.push([id, language, problems.join('; '), JSON.stringify(entry)]);
            } else if (problems) {
                summary.ready += 1;
            }
            const usable = problems && !problems.length;
            for (const [key] of FIELDS) {
                if (!usable) {
                    out.push('');
                } else if (key === 'options') {
                    out.push((Array.isArray(entry.options) ? entry.options : []).map(text).filter(Boolean).join(' | '));
                } else {
                    out.push(text(key === 'question' ? entry.question ?? entry.prompt : key === 'answer' ? entry.answer ?? entry.correctAnswer : entry[key]));
                }
            }
        }
        importRows.push(out);
    }
    return { importRows, heldRows, summary };
}

function main([input, outputFolder]) {
    if (!input) {
        console.error('Usage: node scripts/split-translations.js <input.csv> [output-folder]');
        process.exitCode = 1;
        return;
    }
    const { importRows, heldRows, summary } = splitTranslations(fs.readFileSync(input, 'utf8'));
    const base = path.join(outputFolder || path.dirname(input), path.basename(input, path.extname(input)));
    // The byte-order mark lets Excel open the Hindi and Telugu text correctly.
    fs.writeFileSync(`${base}-import.csv`, `﻿${toCsv(importRows)}`);
    fs.writeFileSync(`${base}-held.csv`, `﻿${toCsv(heldRows)}`);
    console.log(`${summary.questions} questions: ${summary.ready} translations ready, ${summary.held} held for review.`);
    console.log(`Import: ${base}-import.csv`);
    console.log(`Held:   ${base}-held.csv`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { splitTranslations, translationProblems, parseCsv, toCsv };
