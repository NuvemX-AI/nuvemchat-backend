import { createClient } from '@supabase/supabase-js';
// dotenv foi configurado no index.js, então as variáveis de ambiente devem estar disponíveis

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Usar a SERVICE_ROLE_KEY para operações de backend

// Logs de depuração da chave foram removidos.

if (!supabaseUrl) {
  console.error('****** Erro Crítico: SUPABASE_URL não definido no .env ******');
  // Em um cenário real, você poderia lançar um erro ou ter um fallback,
  // mas para desenvolvimento, logar o erro é um bom começo.
}
if (!supabaseKey) {
  console.error('****** Erro Crítico: SUPABASE_SERVICE_ROLE_KEY não definido no .env ******');
}

// Só cria o cliente se as variáveis estiverem presentes
// Em um app real, você pode querer que o app falhe ao iniciar se elas não estiverem configuradas.
export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey, {
    auth: {
      // autoRefreshToken: true, // Padrão é true
      // persistSession: true, // Padrão é true, mas para backend service_role, geralmente não é necessário persistir sessão de usuário
      // detectSessionInUrl: true // Padrão é true, mais relevante para frontend OAuth
    }
  })
  : null;

if (supabase) {
  console.log('Cliente Supabase inicializado com SERVICE_ROLE_KEY.');
} else {
  console.error('!!!!!! Falha ao inicializar o cliente Supabase. Verifique as variáveis de ambiente. !!!!!!');
}

let keyTypeUsed = 'Service Role';
if (supabaseKey === process.env.SUPABASE_ANON_KEY) {
    keyTypeUsed = 'Anon Role';
} else if (!supabaseKey && process.env.SUPABASE_ANON_KEY) {
    keyTypeUsed = 'Anon Role (fallback, SERVICE_ROLE_KEY missing)';
} else if (!supabaseKey && !process.env.SUPABASE_ANON_KEY) {
    keyTypeUsed = 'UNKNOWN (Both keys missing)';
}

console.log(`[SupabaseClient] Supabase client initialized. URL: ${supabaseUrl}, Key Used: ${keyTypeUsed}`); 