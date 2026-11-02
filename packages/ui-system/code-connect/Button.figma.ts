// url=https://www.figma.com/design/7hQqtwmQ8H9UWmn8Hvcnnu/Team-AI-Box?node-id=4-8
// source=packages/ui-system/src/components.tsx
// component=Button
import figma from 'figma';

const instance = figma.selectedInstance;
const label = instance.getString('Label');
const variant = instance.getEnum('Style', {
  Primary: 'primary',
  Secondary: 'secondary',
  Danger: 'danger',
});
const state = instance.getEnum('State', {
  Default: 'default',
  Hover: 'hover',
  Focus: 'focus',
  Disabled: 'disabled',
  Busy: 'busy',
});

// Hover and focus are native CSS states, not invented Button props.
// The existing Button owns busy => disabled and aria-busy behavior.
const disabled = state === 'disabled';
const busy = state === 'busy';

export default {
  example: figma.code`<Button variant="${variant}" ${disabled ? 'disabled' : ''} ${busy ? 'busy' : ''}>${label}</Button>`,
  imports: ['import { Button } from "@teamaibox/ui-system/components";'],
  id: 'teamaibox-button',
  metadata: { nestable: true },
};
