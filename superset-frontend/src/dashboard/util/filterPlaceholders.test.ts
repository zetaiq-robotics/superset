/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 * Added by ZetaIQ (variables spec G8).
 */
import { escapeMarkdown, fillFilterPlaceholders } from './filterPlaceholders';

const filters = {
  'NATIVE_FILTER-r': { name: 'Robot' },
  'NATIVE_FILTER-s': { name: 'Service name' },
  'NATIVE_FILTER-x': { name: 'Unused' },
};
const dataMask = {
  'NATIVE_FILTER-r': { filterState: { value: ['SB-001', 'SB-012'], label: 'SB-001 · Bay 3, SB-012 · Bay 7' } },
  'NATIVE_FILTER-s': { filterState: { value: ['wms'] } },
  'NATIVE_FILTER-x': { filterState: {} },
};

test('a placeholder shows the applied labels, by filter name, any case and spacing', () => {
  expect(fillFilterPlaceholders('Battery — {{robot}} on {{ Service name }}', filters, dataMask)).toBe(
    'Battery — SB-001 · Bay 3, SB-012 · Bay 7 on wms',
  );
});

test('nothing applied reads All; an unknown name is left as typed', () => {
  expect(fillFilterPlaceholders('{{Unused}} / {{Nope}}', filters, dataMask)).toBe('All / {{Nope}}');
});

test('more than five values are shortened', () => {
  const many = { 'NATIVE_FILTER-r': { filterState: { value: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } } };
  expect(fillFilterPlaceholders('{{Robot}}', filters, many)).toBe('a, b, c, d, e, … (+2)');
});

test('text without placeholders is returned unchanged', () => {
  expect(fillFilterPlaceholders('Battery %', filters, dataMask)).toBe('Battery %');
});

test('values are escaped before they reach Markdown', () => {
  const md = { 'NATIVE_FILTER-r': { filterState: { value: ['<img src=x onerror=alert(1)>', '**b**'] } } };
  expect(fillFilterPlaceholders('{{Robot}}', filters, md, escapeMarkdown)).toBe(
    '&lt;img src=x onerror=alert\\(1\\)&gt;, \\*\\*b\\*\\*',
  );
});
