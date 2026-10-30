/** Número que acende dígito a dígito quando muda (linguagem Kobra): cada caractere
 * tem chave própria, então só o que trocou reanima. */
export function Digits({ value }: { value: string }) {
  return <span className="hd-digits" aria-label={value}>{[...value].map((char, index) => <span aria-hidden="true" className="hd-digit" key={`${index}-${char}`} style={{ ["--i" as string]: index }}>{char}</span>)}</span>;
}
