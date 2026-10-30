<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.pt-BR.md)
<!-- doc-navigation:end -->

# Tempo de execução do computador virtual ARM

`Public.Dockerfile` cria o mesmo recurso de presença física (PPI) do ARM TPM exigido pelo tempo de execução original do `windows-arm64-ppi`. Ele constrói o QEMU 11.1.1 a partir do lançamento oficial após verificar sua assinatura desanexada em relação à impressão digital fixada do gerenciador de lançamento. O Debian fornece as bibliotecas e ferramentas de contêiner, não o executável QEMU usado para executar convidados.

Não substitua este executável por um pacote QEMU de distribuição mais antigo. Perfis do Windows ativam `tpm-tis-device,...,ppi=on`; uma compilação sem essa propriedade ARM é encerrada antes do início do firmware. Remover `ppi=on`, desabilitar o TPM ou redefinir o TPM de um convidado não é um reparo compatível.

A construção da imagem final verifica o suporte ARM TIS PPI e PulseAudio e inclui a ROM de framebuffer de RAM correspondente. Em um host ARM KVM, o pacote `python3 /usr/local/bin/probe-ppi` executa uma verificação QEMU/TPM pausada e sem disco. Ele não monta discos convidados existentes nem prova que a instalação do Windows foi concluída. A inicialização do Windows deve ser verificada separadamente em um convidado de teste explicitamente designado.

Para uma instalação existente, use a política de atualização de tempo de execução da plataforma e o resumo da imagem de perfil do Node Agent correspondente. Preservar disco, firmware, identidade e estado do TPM. Não recrie convidados nem altere imagens de convidados do Linux em execução apenas para reparar o tempo de execução do Windows. Registre imagens construídas localmente como não publicadas até que suas alterações de origem sejam confirmadas e liberadas.

Preserve a propriedade da configuração instalada e as permissões de leitura ao atualizá-la. Se a API da plataforma for recriada para carregar a política de atualização de tempo de execução, recrie também seus dependentes de namespace de rede (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` e `maintenance-controller`) a partir de suas imagens inalteradas. Eles devem ingressar no namespace de rede do novo contêiner de API. Este não é um convidado, daemon do Docker ou reinicialização do trabalhador de IA. Aguarde a pulsação autenticada normal do nó para restaurar a prontidão antes de enviar uma operação de inicialização do Windows.
