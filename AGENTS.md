# Heydesk — regras para agentes

## Cartões com botões no notch compacto

Passar o mouse sobre o notch compacto abre o painel (`useIsland`, `setPointer`). Qualquer cartão que aparece no compacto e tem botões (lembrete de água, aviso de atualização, e os próximos que vierem) **precisa segurar o hover**, senão o painel abre por cima e o usuário não consegue clicar.

- Ao criar ou mudar um cartão interativo no compacto, inclua a condição dele no último argumento de `useIsland(...)` em `src/App.tsx` (`hold`), hoje `waterPending || Boolean(updateInfo)`.
- Se o estado do cartão vem de um hook declarado depois de `useIsland`, mova o hook para antes.
- Confira no build de debug: com o cartão visível, passar o mouse não abre o notch, e os botões respondem ao clique.
