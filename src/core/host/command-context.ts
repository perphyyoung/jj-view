/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoggerChannel } from '../../utils/output-channel';
import type { JjRepository } from '../jj-repository';
import type { HostEnvironment } from './host-environment';

export interface CommandContext {
    readonly repo: JjRepository;
    readonly host: HostEnvironment;
    readonly log: LoggerChannel;
}

export class BaseCommandContext implements CommandContext {
    constructor(
        readonly repo: JjRepository,
        readonly host: HostEnvironment,
        readonly log: LoggerChannel,
    ) {}
}
