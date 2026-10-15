/** Reads a text field from FormData; file inputs and missing fields yield an empty string. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
