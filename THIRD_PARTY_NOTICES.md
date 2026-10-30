# Atribuições de terceiros

Heydesk deriva do projeto [PILLAR](https://github.com/warpirate/pillar-dynamic-island-for-windows), de warpirate, sob licença MIT. A base foi fixada no commit `4017de9ee1c83d156952771a9f685175bbb27e9f`. O texto integral da licença e o aviso original de copyright permanecem no arquivo `LICENSE`.

O histórico upstream é preservado no Git. Foram adaptados o shell Tauri, conceitos da ilha compacta/expandida, estilos/animações e rotinas de janela/bandeja. O código dos módulos retirados pode ser consultado no commit de origem. Os ícones herdados em `public/` e `src-tauri/icons/` permanecem provisoriamente atribuídos ao PILLAR; a proveniência de assets e a identidade definitiva precisam ser verificadas antes de distribuição.

As dependências JavaScript e Rust têm licenças próprias. Os lockfiles fixam versões; não substituem textos de licenças, arquivos NOTICE ou inventário do instalador. A aprovação de distribuição permanece pendente da revisão dos componentes efetivamente incluídos no artefato Windows.

## Referência visual Nusa

Forma do notch, composição visual e mascote com olhos/brilho foram reproduzidos a pedido explícito do usuário, a partir do [Nusa, de Rama](https://rama2555.github.io/nusa/). A investigação também examinou estaticamente o executável oficial 1.1.0 para recuperar sua matemática de movimento. A marca Nusa e o executável original não são distribuídos como componentes do Heydesk.

A licença MIT do PILLAR não constitui licença dos elementos de terceiros usados como referência. Não foi localizada uma licença do aplicativo Nusa na árvore pública consultada. A proveniência, os hashes e os limites da investigação estão em `docs/evidence/nusa-native-rea-2026-10-28.md` e `docs/evidence/nusa-visual-study-2026-10-28.md`.
