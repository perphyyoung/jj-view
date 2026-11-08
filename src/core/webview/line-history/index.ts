/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { hydrate, mount } from 'svelte';
import LineHistoryApp from './LineHistoryApp.svelte';

const rootElement = document.getElementById('root');
if (rootElement) {
    if (rootElement.hasChildNodes()) {
        hydrate(LineHistoryApp, { target: rootElement });
    } else {
        mount(LineHistoryApp, { target: rootElement });
    }
}
