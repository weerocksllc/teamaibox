export function taskLabel(titleKey: string, translate: (key: string) => string) {
  const label = translate(titleKey);
  // Keep historical tasks readable without reintroducing retired features.
  return label === titleKey ? translate('tasks.kind.unknown') : label;
}
