# Heydesk

Notch inteligente para o Windows: uma ilha no topo da tela com mídia e letras, agenda, tarefas, lembrete de água, prateleira de arquivos (inclusive para o celular, por QR), uso do Claude/Codex, placares, teleprompter e gravação de tela.

## Instalar

Baixe o `Heydesk_x.y.z_x64-setup.exe` da [última versão](https://github.com/eudresfs/heydesk/releases/latest) e execute. Não precisa de administrador. Depois de instalado, o Heydesk se atualiza sozinho quando sai uma versão nova.

O instalador ainda não tem assinatura de código, então o Windows pode mostrar o aviso do SmartScreen na primeira vez ("Mais informações" › "Executar assim mesmo").

### Gravação de tela

Usa o FFmpeg instalado no PC:

```
winget install Gyan.FFmpeg
```

## Contas e chaves

O Heydesk não traz nenhuma chave embutida. Cada pessoa usa as próprias contas e chaves (Claude, calendários ICS, serviços de placar), configuradas no próprio app e guardadas só no próprio PC.

## Desenvolvimento

```
npm install
npm run tauri dev
```

Testes: `npm test` (interface) e `npm run test:native` (Rust).

### Publicar uma versão

1. Gere sua chave de assinatura uma vez: `npx tauri signer generate -w %USERPROFILE%\.tauri\heydesk.key` e coloque a chave pública em `plugins.updater.pubkey` de `src-tauri/tauri.conf.json`.
2. Suba a versão em `package.json`, `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json` e faça commit.
3. Rode `powershell -ExecutionPolicy Bypass -File scripts\release.ps1`.

A chave privada fica só no seu PC; o script assina, cria a tag e publica a Release com o `latest.json` que os apps instalados consultam.

## Licença

MIT. Baseado no [PILLAR](https://github.com/warpirate/pillar-dynamic-island-for-windows).
