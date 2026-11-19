export type ColumnType = 'text' | 'number' | 'select' | 'date' | 'person' | 'checkbox';

export interface SelectOption {
  value: string;
  color: string;
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  width?: number;
  options?: SelectOption[];
}

const opt = (value: string, color: string): SelectOption => ({ value, color });

export interface SheetTemplate {
  key: string;
  name: string;
  description: string;
  columns: Omit<Column, 'id'>[];
  rows?: number;
}

export const SHEET_TEMPLATES: SheetTemplate[] = [
  {
    key: 'ioc',
    name: 'IOC Tracker',
    description: 'Indicators of compromise: IPs, domains, hashes and their handling status.',
    columns: [
      { name: 'Indicator', type: 'text', width: 260 },
      {
        name: 'Type',
        type: 'select',
        options: [
          opt('IP', 'blue'),
          opt('Domain', 'purple'),
          opt('URL', 'purple'),
          opt('Hash', 'gray'),
          opt('Email', 'teal'),
          opt('File', 'gray'),
          opt('Account', 'orange'),
        ],
      },
      {
        name: 'Status',
        type: 'select',
        options: [
          opt('New', 'gray'),
          opt('Investigating', 'yellow'),
          opt('Blocked', 'green'),
          opt('False positive', 'blue'),
        ],
      },
      { name: 'First seen (UTC)', type: 'date' },
      { name: 'Source', type: 'text' },
      { name: 'Owner', type: 'person' },
      { name: 'Notes', type: 'text', width: 280 },
    ],
  },
  {
    key: 'assets',
    name: 'Affected Assets',
    description: 'Hosts, services and accounts in scope, with containment progress.',
    columns: [
      { name: 'Asset', type: 'text', width: 200 },
      { name: 'IP / FQDN', type: 'text', width: 180 },
      { name: 'Asset owner', type: 'text' },
      {
        name: 'Impact',
        type: 'select',
        options: [opt('Critical', 'red'), opt('High', 'orange'), opt('Medium', 'yellow'), opt('Low', 'blue')],
      },
      {
        name: 'Containment',
        type: 'select',
        options: [
          opt('Not started', 'gray'),
          opt('Isolated', 'yellow'),
          opt('Reimaged', 'blue'),
          opt('Restored', 'green'),
        ],
      },
      { name: 'Assignee', type: 'person' },
      { name: 'Evidence collected', type: 'checkbox', width: 140 },
      { name: 'Notes', type: 'text', width: 260 },
    ],
  },
  {
    key: 'actions',
    name: 'Action Items',
    description: 'Who is doing what, by when.',
    columns: [
      { name: 'Action', type: 'text', width: 320 },
      { name: 'Owner', type: 'person' },
      {
        name: 'Priority',
        type: 'select',
        options: [opt('P1', 'red'), opt('P2', 'orange'), opt('P3', 'blue')],
      },
      {
        name: 'Status',
        type: 'select',
        options: [opt('Open', 'gray'), opt('In progress', 'yellow'), opt('Blocked', 'red'), opt('Done', 'green')],
      },
      { name: 'Due (UTC)', type: 'date' },
      { name: 'Done', type: 'checkbox', width: 90 },
    ],
  },
  {
    key: 'comms',
    name: 'Comms Log',
    description: 'Every update sent to stakeholders, customers and regulators.',
    columns: [
      { name: 'Sent (UTC)', type: 'date' },
      {
        name: 'Audience',
        type: 'select',
        options: [
          opt('Executives', 'purple'),
          opt('Internal', 'blue'),
          opt('Customers', 'orange'),
          opt('Regulator', 'red'),
          opt('Legal', 'gray'),
        ],
      },
      { name: 'Channel', type: 'text' },
      { name: 'Summary', type: 'text', width: 360 },
      { name: 'Sent by', type: 'person' },
      { name: 'Approved', type: 'checkbox', width: 110 },
    ],
  },
  {
    key: 'blank',
    name: 'Blank sheet',
    description: 'Empty grid with a few text columns.',
    columns: [
      { name: 'A', type: 'text' },
      { name: 'B', type: 'text' },
      { name: 'C', type: 'text' },
      { name: 'D', type: 'text' },
    ],
  },
];

export const ROLES = [
  { key: 'commander', label: 'Incident Commander' },
  { key: 'scribe', label: 'Scribe' },
  { key: 'comms', label: 'Comms Lead' },
  { key: 'tech', label: 'Tech Lead' },
  { key: 'security', label: 'Security Lead' },
] as const;

export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export const STATUSES = ['investigating', 'identified', 'mitigating', 'monitoring', 'resolved'] as const;
