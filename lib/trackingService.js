import fetch from 'node-fetch'; // Certifique-se de que node-fetch está instalado ou use o http global do Node.js

// Variável de ambiente para a chave da API do 17TRACK
const API_KEY_17TRACK = process.env.TRACKING_API_KEY_17TRACK;
const API_ENDPOINT_17TRACK = 'https://api.17track.net/track/v1';

/**
 * Busca informações de rastreamento da API do 17TRACK.
 * @param {string} trackingNumber O número de rastreamento.
 * @param {string} [carrierCodeParam] Opcional. O código da transportadora, se conhecido.
 * @returns {Promise<object|null>} Um objeto com os dados de rastreamento ou null em caso de erro.
 */
export async function getTrackingInfo17Track(trackingNumber, carrierCodeParam = null) {
    if (!API_KEY_17TRACK) {
        console.error('[17TRACK Service] TRACKING_API_KEY_17TRACK não está configurada nas variáveis de ambiente.');
        return { error: true, message: 'Chave da API do serviço de rastreamento não configurada.' };
    }

    if (!trackingNumber || typeof trackingNumber !== 'string' || trackingNumber.trim() === '') {
        console.error('[17TRACK Service] Número de rastreamento inválido fornecido.');
        return { error: true, message: 'Número de rastreamento inválido.' };
    }

    const requestBodyRegister = [{ number: trackingNumber }];
    if (carrierCodeParam) {
        requestBodyRegister[0].carrier = parseInt(carrierCodeParam, 10);
    }

    console.log(`[17TRACK Service] Registrando/buscando rastreio para: ${trackingNumber}, Carrier: ${carrierCodeParam || 'auto-detect'}`);

    try {
        // 1. Registrar o número para rastreamento (necessário antes de obter informações)
        const registerResponse = await fetch(`${API_ENDPOINT_17TRACK}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                '17token': API_KEY_17TRACK
            },
            body: JSON.stringify(requestBodyRegister)
        });

        const registerData = await registerResponse.json();

        if (registerResponse.status !== 200 || registerData.code !== 0) {
            console.error(`[17TRACK Service] Erro ao registrar ${trackingNumber}. Status: ${registerResponse.status}`, registerData);
            let alreadyRegistered = false;
            if (registerData.data && registerData.data.rejected && registerData.data.rejected.length > 0) {
                registerData.data.rejected.forEach(item => {
                    if (item.error && item.error.code === -18019901) {
                        alreadyRegistered = true;
                    }
                });
            } else if (registerData.data && registerData.data.accepted && registerData.data.accepted.length > 0) {
                alreadyRegistered = true;
            }

            if (!alreadyRegistered) {
                 return { 
                    error: true, 
                    message: registerData.data?.rejected?.[0]?.error?.message || `Falha ao registrar rastreamento. Código: ${registerData.code}`,
                    details: registerData 
                };
            }
            console.log(`[17TRACK Service] ${trackingNumber} já estava registrado ou foi registrado com sucesso. Prosseguindo para buscar informações.`);
        } else {
            console.log(`[17TRACK Service] ${trackingNumber} registrado com sucesso ou já existente (resposta OK).`, registerData.data?.accepted);
        }

        const requestBodyGetInfo = [{ number: trackingNumber }];
        if (carrierCodeParam) {
            requestBodyGetInfo[0].carrier = parseInt(carrierCodeParam, 10);
        }

        const getInfoResponse = await fetch(`${API_ENDPOINT_17TRACK}/gettrackinfo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                '17token': API_KEY_17TRACK
            },
            body: JSON.stringify(requestBodyGetInfo)
        });

        const getInfoData = await getInfoResponse.json();

        if (getInfoResponse.status !== 200 || getInfoData.code !== 0) {
            console.error(`[17TRACK Service] Erro ao obter informações para ${trackingNumber}. Status: ${getInfoResponse.status}`, getInfoData);
            return { 
                error: true, 
                message: getInfoData.data?.rejected?.[0]?.error?.message || `Falha ao obter informações de rastreamento. Código: ${getInfoData.code}`,
                details: getInfoData
            };
        }

        if (getInfoData.data && getInfoData.data.accepted && getInfoData.data.accepted.length > 0) {
            const trackingResult = getInfoData.data.accepted[0];
            console.log(`[17TRACK Service] Informações de rastreamento obtidas para ${trackingNumber}`);
            
            if (trackingResult.track && trackingResult.track.z1 && trackingResult.track.z1.length > 0) {
                const latestEvent = trackingResult.track.z0;
                return {
                    success: true,
                    trackingNumber: trackingResult.number,
                    carrier: trackingResult.track.w1,
                    status: mapPackageStatus17Track(trackingResult.track.e),
                    latestEvent: {
                        timestamp: latestEvent.a,
                        location: latestEvent.c,
                        description: latestEvent.z,
                    },
                    originCountry: trackingResult.track.b,
                    destinationCountry: trackingResult.track.c,
                    allEvents: trackingResult.track.z1.map(event => ({
                        timestamp: event.a,
                        location: event.c,
                        description: event.z,
                    })),
                };
            } else if (getInfoData.data.rejected && getInfoData.data.rejected.length > 0 && getInfoData.data.rejected[0].error?.code === -18019909) {
                 console.log(`[17TRACK Service] Nenhuma informação de rastreamento ainda para ${trackingNumber}.`);
                return {
                    success: true,
                    isEmpty: true,
                    trackingNumber: trackingNumber,
                    message: "Nenhuma informação de rastreamento disponível no momento. Isso pode acontecer se o objeto foi postado recentemente. Tente novamente mais tarde."
                };
            }
             else {
                console.log(`[17TRACK Service] Nenhuma informação de rastreamento detalhada (z1) encontrada para ${trackingNumber}.`, trackingResult);
                return { 
                    error: true, 
                    message: 'Nenhuma informação de evento de rastreamento encontrada.',
                    details: trackingResult
                };
            }
        } else if (getInfoData.data && getInfoData.data.rejected && getInfoData.data.rejected.length > 0) {
             console.warn(`[17TRACK Service] Requisição para gettrackinfo retornou 'rejected' para ${trackingNumber}:`, getInfoData.data.rejected);
             return {
                error: true,
                message: getInfoData.data.rejected[0].error?.message || 'Falha ao obter informações de rastreamento (rejeitado).',
                details: getInfoData.data.rejected[0]
            };
        } else {
            console.warn(`[17TRACK Service] Resposta inesperada de gettrackinfo para ${trackingNumber}:`, getInfoData);
            return { error: true, message: 'Resposta inesperada do serviço de rastreamento.', details: getInfoData };
        }

    } catch (error) {
        console.error(`[17TRACK Service] Exceção geral ao buscar rastreamento para ${trackingNumber}:`, error);
        return { error: true, message: `Exceção no serviço de rastreamento: ${error.message}` };
    }
}

/**
 * Mapeia o código de status do pacote do 17TRACK para uma string descritiva.
 * @param {number} statusCode O código de status numérico do 17TRACK (campo 'e').
 * @returns {string} Uma descrição textual do status.
 */
function mapPackageStatus17Track(statusCode) {
    switch (statusCode) {
        case 0: return 'Não encontrado'; // Not found
        case 10: return 'Em trânsito';   // In transit
        case 20: return 'Expirado';     // Expired (parou de atualizar)
        case 30: return 'Para retirada';// Pick up (aguardando retirada ou pronto para entrega)
        case 35: return 'Entrega falhou'; // Undelivered
        case 40: return 'Entregue';     // Delivered
        case 50: return 'Alerta';       // Alert (exceção, devolução, etc.)
        default: return 'Status desconhecido';
    }
}

/**
 * Registra um único número de rastreamento na API do 17TRACK.
 * @param {string} trackingNumber O número de rastreamento a ser registrado.
 * @param {string} [carrierCode] Opcional. O código da transportadora, se conhecido.
 * @returns {Promise<{success: boolean, message: string, details?: any}>}
 */
export async function registerSingleTrackingNumber17Track(trackingNumber, carrierCode = null) {
    if (!API_KEY_17TRACK) {
        console.error('[17TRACK Service Register] TRACKING_API_KEY_17TRACK não está configurada.');
        return { success: false, message: 'Chave da API do serviço de rastreamento não configurada.' };
    }
    if (!trackingNumber || typeof trackingNumber !== 'string' || trackingNumber.trim() === '') {
        console.error('[17TRACK Service Register] Número de rastreamento inválido fornecido.');
        return { success: false, message: 'Número de rastreamento inválido.' };
    }

    const requestBodyRegister = [{ number: trackingNumber }];
    if (carrierCode) {
        const numericCarrierCode = parseInt(carrierCode, 10);
        if (!isNaN(numericCarrierCode)) {
            requestBodyRegister[0].carrier = numericCarrierCode;
        } else if (carrierCode) {
            console.warn(`[17TRACK Service Register] Carrier code '${carrierCode}' não é numérico, 17TRACK tentará auto-detecção para ${trackingNumber}.`);
        }
    }

    console.log(`[17TRACK Service Register] Registrando rastreio: ${trackingNumber}, Carrier: ${carrierCode || 'auto-detect'}`);

    try {
        const registerResponse = await fetch(`${API_ENDPOINT_17TRACK}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                '17token': API_KEY_17TRACK
            },
            body: JSON.stringify(requestBodyRegister)
        });

        const registerData = await registerResponse.json();

        if (registerResponse.status === 200 && registerData.code === 0) {
            if (registerData.data && registerData.data.accepted && registerData.data.accepted.length > 0) {
                console.log(`[17TRACK Service Register] ${trackingNumber} registrado com sucesso ou já existente (aceito).`, registerData.data.accepted[0]);
                return { success: true, message: 'Rastreamento registrado/aceito com sucesso.', details: registerData.data.accepted[0] };
            } else if (registerData.data && registerData.data.rejected && registerData.data.rejected.length > 0) {
                const rejection = registerData.data.rejected[0];
                if (rejection.error && rejection.error.code === -18019901) {
                    console.log(`[17TRACK Service Register] ${trackingNumber} já estava registrado (rejeitado com código -18019901).`);
                    return { success: true, message: 'Rastreamento já estava registrado.', details: rejection };
                }
                console.warn(`[17TRACK Service Register] ${trackingNumber} rejeitado por outra razão.`, rejection);
                return { success: false, message: rejection.error?.message || 'Falha ao registrar rastreamento (rejeitado).', details: rejection };
            }
            console.warn(`[17TRACK Service Register] Resposta OK do 17TRACK para ${trackingNumber}, mas sem dados 'accepted' ou 'rejected' claros.`, registerData);
            return { success: true, message: 'Registro processado pelo 17TRACK, mas o resultado é indeterminado (sem \'accepted\' ou \'rejected\' claros).', details: registerData };

        } else {
            console.error(`[17TRACK Service Register] Erro ao registrar ${trackingNumber}. Status: ${registerResponse.status}`, registerData);
            let errorMessage = `Falha ao registrar rastreamento. Código API: ${registerData.code}`;
            if(registerData.data && registerData.data.rejected && registerData.data.rejected.length > 0 && registerData.data.rejected[0].error) {
                errorMessage = registerData.data.rejected[0].error.message || errorMessage;
            }
            return { success: false, message: errorMessage, details: registerData };
        }
    } catch (error) {
        console.error(`[17TRACK Service Register] Exceção geral ao registrar ${trackingNumber}:`, error);
        return { success: false, message: `Exceção no serviço de registro: ${error.message}` };
    }
} 