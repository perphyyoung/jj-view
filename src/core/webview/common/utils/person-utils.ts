/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getRelativeTimeString } from './time-utils';

export interface PersonInfoProps {
    person?: { name: string; email: string; timestamp: string };
    label: string;
}

export interface PersonDisplayStrings {
    nameToDisplay: string;
    emailToDisplay: string;
    fullTime: string;
    relTime: string;
    hasEmail: boolean;
}

export function getPersonDisplayStrings(person: {
    name: string;
    email: string;
    timestamp: string;
}): PersonDisplayStrings {
    const hasName = !!person.name && person.name !== '•';
    const hasEmail = !!person.email;

    const nameToDisplay = hasName ? person.name : hasEmail ? person.email : '(no name set)';
    const emailToDisplay = hasEmail ? person.email : '(no email set)';

    // Format explicitly: `toLocaleString()` depends on the runtime locale, so the same
    // commit rendered in the webview (Chromium) and in tests (Node) produced different
    // text, and the tooltip changed with the VS Code display language.
    const date = new Date(person.timestamp);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const fullTime = Number.isNaN(date.getTime())
        ? person.timestamp
        : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    let relTime = person.timestamp;
    try {
        relTime = getRelativeTimeString(person.timestamp);
    } catch {
        // fallback to just rendering the timestamp string
    }

    return { nameToDisplay, emailToDisplay, fullTime, relTime, hasEmail };
}
