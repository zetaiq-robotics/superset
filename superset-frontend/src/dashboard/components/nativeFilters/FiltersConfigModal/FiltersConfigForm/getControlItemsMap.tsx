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
 * Modified by ZetaIQ: filter plugins may declare text, select and column
 * controls besides checkboxes.
 */
import { CustomControlItem } from '@superset-ui/chart-controls';
import { ReactNode } from 'react';
import {
  Checkbox,
  FormItem,
  InfoTooltip,
  Input,
  Select,
  Tooltip,
  type FormInstance,
} from '@superset-ui/core/components';
import { t } from '@apache-superset/core/translation';
import {
  Filter,
  ChartCustomization,
  DatasourceType,
  getChartControlPanelRegistry,
} from '@superset-ui/core';
import { styled } from '@apache-superset/core/theme';
import {
  doesColumnMatchFilterType,
  getControlItems,
  setNativeFilterFieldValues,
} from './utils';
import { NativeFiltersForm, NativeFiltersFormItem } from '../types';
import {
  StyledFormItem,
  StyledLabel,
  StyledRowFormItem,
} from './FiltersConfigForm';
import { ColumnSelect } from './ColumnSelect';

export interface ControlItemsProps {
  expanded: boolean;
  datasetId: number;
  datasourceType?: DatasourceType;
  disabled: boolean;
  forceUpdate: Function;
  formChanged: Function;
  form: FormInstance<NativeFiltersForm>;
  filterId: string;
  filterType: string;
  filterToEdit?: Filter;
  customizationToEdit?: ChartCustomization;
  formFilter?: NativeFiltersFormItem;
  removed?: boolean;
}

const CleanFormItem = styled(FormItem)`
  margin-bottom: 0;
`;

export default function getControlItemsMap({
  expanded,
  datasetId,
  datasourceType,
  disabled,
  forceUpdate,
  formChanged,
  form,
  filterId,
  filterType,
  filterToEdit,
  customizationToEdit,
  formFilter,
  removed,
}: ControlItemsProps) {
  const controlPanelRegistry = getChartControlPanelRegistry();
  const controlItems =
    getControlItems(controlPanelRegistry.get(filterType)) ?? [];
  const mapControlItems: Record<
    string,
    { element: ReactNode; checked: boolean }
  > = {};
  const mapMainControlItems: Record<
    string,
    { element: ReactNode; checked: boolean }
  > = {};

  // Text, select and column controls a filter plugin declares by
  // `config.type`; saved under controlValues like the checkboxes.
  const typedControl = (
    controlItem: CustomControlItem,
    initialValue: unknown,
  ): ReactNode => {
    const { type, label, description, choices, resetConfig } =
      controlItem.config as Record<string, any>;
    const labelText = typeof label === 'function' ? label() : label;
    const onChange = () => {
      if (resetConfig) {
        setNativeFilterFieldValues(form, filterId, { defaultDataMask: null });
      }
      formChanged();
      forceUpdate();
    };
    let input: ReactNode;
    if (type === 'TextControl') {
      input = <Input onChange={onChange} />;
    } else if (type === 'TextAreaControl') {
      input = <Input.TextArea rows={4} onChange={onChange} />;
    } else if (type === 'SelectControl') {
      input = (
        <Select
          ariaLabel={labelText}
          options={(choices ?? []).map(([value, text]: [string, string]) => ({
            value,
            label: text,
          }))}
          onChange={onChange}
        />
      );
    } else if (type === 'ColumnSelectControl') {
      input = (
        <ColumnSelect
          allowClear
          form={form}
          filterId={filterId}
          fieldPath={['controlValues', controlItem.name]}
          datasetId={datasetId}
          datasourceType={datasourceType}
          onChange={onChange}
        />
      );
    } else {
      return null;
    }
    return (
      <StyledFormItem
        expanded={expanded}
        key={controlItem.name}
        name={['filters', filterId, 'controlValues', controlItem.name]}
        initialValue={initialValue}
        label={
          <StyledLabel>
            {labelText}
            {description && (
              <>
                &nbsp;
                <InfoTooltip
                  placement="top"
                  tooltip={
                    typeof description === 'function'
                      ? description()
                      : description
                  }
                />
              </>
            )}
          </StyledLabel>
        }
      >
        {input}
      </StyledFormItem>
    );
  };

  controlItems
    .filter(
      (mainControlItem: CustomControlItem) =>
        mainControlItem?.name === 'groupby',
    )
    .forEach(mainControlItem => {
      const initialValue =
        filterToEdit?.controlValues?.[mainControlItem.name] ??
        customizationToEdit?.controlValues?.[mainControlItem.name] ??
        mainControlItem?.config?.default;
      const initColumn =
        customizationToEdit?.targets?.[0]?.column?.name ??
        filterToEdit?.targets?.[0]?.column?.name;

      const element = (
        <>
          <CleanFormItem
            name={['filters', filterId, 'requiredFirst', mainControlItem.name]}
            hidden
            initialValue={
              mainControlItem?.config?.requiredFirst &&
              filterToEdit?.requiredFirst
            }
          />
          <StyledFormItem
            expanded={expanded}
            // don't show the column select unless we have a dataset
            name={['filters', filterId, 'column']}
            initialValue={initColumn}
            label={
              <StyledLabel>
                {typeof mainControlItem.config?.label === 'function'
                  ? (mainControlItem.config.label as Function)()
                  : mainControlItem.config?.label || t('Column')}
              </StyledLabel>
            }
            rules={[
              {
                required: mainControlItem.config?.required && !removed, // TODO: need to move ColumnSelect settings to controlPanel for all filters
                message: t('Column is required'),
              },
            ]}
            data-test="field-input"
          >
            <ColumnSelect
              mode={mainControlItem.config?.multiple && 'multiple'}
              form={form}
              filterId={filterId}
              datasetId={datasetId}
              datasourceType={datasourceType}
              filterValues={column =>
                doesColumnMatchFilterType(
                  formFilter?.filterType || '',
                  column,
                ) && !!column?.filterable
              }
              onChange={() => {
                // We need reset default value when column changed
                setNativeFilterFieldValues(form, filterId, {
                  defaultDataMask: null,
                });
                forceUpdate();
                formChanged();
              }}
            />
          </StyledFormItem>
        </>
      );
      mapMainControlItems[mainControlItem.name] = {
        element,
        checked: initialValue,
      };
    });
  controlItems
    .filter(
      (controlItem: CustomControlItem) =>
        controlItem?.config?.renderTrigger &&
        controlItem.name !== 'sortAscending' &&
        controlItem.name !== 'enableSingleValue' &&
        controlItem.name !== 'operatorType',
    )
    .forEach(controlItem => {
      const initialValue =
        filterToEdit?.controlValues?.[controlItem.name] ??
        customizationToEdit?.controlValues?.[controlItem.name] ??
        controlItem?.config?.default;
      const typed = typedControl(controlItem, initialValue);
      if (typed) {
        mapControlItems[controlItem.name] = {
          element: typed,
          checked: initialValue,
        };
        return;
      }
      const element = (
        <>
          <CleanFormItem
            name={['filters', filterId, 'requiredFirst', controlItem.name]}
            hidden
            initialValue={
              controlItem?.config?.requiredFirst && filterToEdit?.requiredFirst
            }
          />
          <Tooltip
            key={controlItem.name}
            placement="left"
            title={
              controlItem.config.affectsDataMask &&
              disabled &&
              t('Populate "Default value" to enable this control')
            }
          >
            {/* Wrap in span so antd Tooltip can attach a ref without
                relying on findDOMNode (deprecated in React 18+). */}
            <span>
              <StyledRowFormItem
                expanded={expanded}
                key={controlItem.name}
                name={['filters', filterId, 'controlValues', controlItem.name]}
                initialValue={initialValue}
                valuePropName="checked"
                colon={false}
              >
                <Checkbox
                  disabled={controlItem.config.affectsDataMask && disabled}
                  onChange={checked => {
                    if (controlItem.config.requiredFirst) {
                      setNativeFilterFieldValues(form, filterId, {
                        requiredFirst: {
                          ...formFilter?.requiredFirst,
                          [controlItem.name]: checked,
                        },
                      });
                    }
                    if (controlItem.config.resetConfig) {
                      setNativeFilterFieldValues(form, filterId, {
                        defaultDataMask: null,
                      });
                    }
                    formChanged();
                    forceUpdate();
                  }}
                >
                  <>
                    {typeof controlItem.config.label === 'function'
                      ? (controlItem.config.label as Function)()
                      : controlItem.config.label}
                    &nbsp;
                    {controlItem.config.description && (
                      <InfoTooltip
                        placement="top"
                        tooltip={
                          typeof controlItem.config.description === 'function'
                            ? (controlItem.config.description as Function)()
                            : (controlItem.config
                                .description as React.ReactNode)
                        }
                      />
                    )}
                  </>
                </Checkbox>
              </StyledRowFormItem>
            </span>
          </Tooltip>
        </>
      );
      mapControlItems[controlItem.name] = { element, checked: initialValue };
    });
  return {
    controlItems: mapControlItems,
    mainControlItems: mapMainControlItems,
  };
}
