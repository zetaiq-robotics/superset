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
 */
import {
  adoptAfterOwnWrite,
  ifMatch,
  noteNewer,
  versionOf,
} from './versionTracker';

test('own write from the base moves the base', () => {
  expect(adoptAfterOwnWrite({ base: 'a', latest: 'a' }, 'a', 'b')).toEqual({
    base: 'b',
    latest: 'b',
  });
});

test('own write from a tab that is behind keeps the base', () => {
  expect(adoptAfterOwnWrite({ base: 'a', latest: 'c' }, 'c', 'd')).toEqual({
    base: 'a',
    latest: 'd',
  });
});

test('versionOf strips quotes and everything from the first colon', () => {
  expect(versionOf('"u:h:zstd"')).toBe('u');
  expect(versionOf('"u:h"')).toBe('u');
  expect(versionOf('"u"')).toBe('u');
  expect(versionOf('u')).toBe('u');
  // a compressing proxy may weaken the tag
  expect(versionOf('W/"u:h"')).toBe('u');
  expect(versionOf(null)).toBeNull();
  expect(versionOf('')).toBeNull();
});

test('noteNewer sets only latest', () => {
  expect(noteNewer({ base: 'a', latest: 'a' }, '"c:h"')).toEqual({
    base: 'a',
    latest: 'c',
  });
});

test('ifMatch quotes the base and is empty without one', () => {
  expect(ifMatch('a')).toEqual({ 'If-Match': '"a"' });
  expect(ifMatch(null)).toEqual({});
  expect(ifMatch(undefined)).toEqual({});
});
