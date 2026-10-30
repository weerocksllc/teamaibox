<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.pt-BR.md)
<!-- doc-navigation:end -->

# Capturas de tela públicas do produto

Estas são capturas reais do ambiente de trabalho Team AI Box, uma imagem clara e uma imagem escura para cada um dos 17 locais da IU. Eles são ativos de documentação do produto, não a fonte, os modelos ou a saída de construção do site de marketing privado.

## Regras de captura

- Use a linguagem real do produto e os controles de tema; não traduza rótulos em uma captura de tela em inglês nem invente um resultado bem-sucedido.
- Use uma conta de demonstração e inspecione cada imagem em busca de mensagens pessoais, nomes de arquivos, credenciais, PINs do receptor, endereços de rede e cromo do navegador. Nunca publique um disco de convidado conectado ou uma exportação de sessão/cookie com imagens.
- As capturas atuais do ambiente de trabalho mostram apenas o status genérico da tarefa de demonstração e a conta genérica do Administrador. Eles não expõem cargas úteis de tarefas.
- Mantenha as configurações do produto como estavam após a captura. Não exclua dados do usuário nem execute novamente cargas de trabalho de negócios para obter uma captura de tela.
- `workbench-light.jpg` and `workbench-dark.jpg` são os originais. A maioria usa captura de página inteira. O árabe usa a janela de visualização real porque a captura RTL de página inteira do navegador deslocou a página; nenhum rótulo ou resultado foi alterado.
- Algumas palavras de status de tarefas ativas ainda estão em inglês em visualizações localizadas. Essas imagens preservam intencionalmente a IU enviada em vez de retocá-la. Os sistemas operacionais convidados, as respostas do modelo e os nomes definidos pelo usuário têm configurações de idioma separadas e não são traduzidos pelo seletor de UI.

O renderizador README requer ambas as imagens para cada localidade do produto e falha em vez de retornar silenciosamente para uma captura de tela em inglês. Ao atualizar a IU, substitua ambos os temas e gere novamente o manifesto da imagem com `node tools/screenshot-manifest.mjs`. Mantenha os identificadores de rede/dispositivo e os logs de captura local fora deste diretório público.
