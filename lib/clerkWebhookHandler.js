import { Webhook } from 'svix';
import { supabase } from './supabaseClient.js'; // Ajuste o caminho se necessário

const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

async function handleClerkWebhook(req, res) {
  console.log("[Clerk Webhook Handler File] Received event request.");

  if (!WEBHOOK_SECRET) {
    console.error("[Clerk Webhook Handler File] Critical: CLERK_WEBHOOK_SECRET is not set in .env file.");
    return res.status(500).send("Webhook secret not configured on server.");
  }

  const svix_id = req.headers["svix-id"];
  const svix_timestamp = req.headers["svix-timestamp"];
  const svix_signature = req.headers["svix-signature"];

  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.warn("[Clerk Webhook Handler File] Warning: Missing one or more Svix headers.", { svix_id, svix_timestamp, svix_signature: !!svix_signature });
    return res.status(400).send("Error occurred -- missing Svix headers.");
  }

  const rawPayload = req.rawBody; // Espera-se que req.rawBody seja populado pelo middleware no index.js

  console.log("[Clerk Webhook Handler File] Type of req.rawBody:", typeof rawPayload);
  if (typeof rawPayload === 'string') {
    console.log("[Clerk Webhook Handler File] req.rawBody (first 100 chars):", rawPayload.substring(0, 100));
  } else if (Buffer.isBuffer(rawPayload)) {
    console.log("[Clerk Webhook Handler File] req.rawBody is a Buffer. Length:", rawPayload.length);
  }

  if (typeof rawPayload !== 'string' && !Buffer.isBuffer(rawPayload)) {
    console.error("[Clerk Webhook Handler File] Critical error: req.rawBody is not a string or Buffer. Current type:", typeof rawPayload);
    console.error("[Clerk Webhook Handler File] Original req.body type:", typeof req.body);
    return res.status(500).send("Error occurred -- server misconfiguration for webhook payload handling.");
  }

  const wh = new Webhook(WEBHOOK_SECRET);
  let evt;

  try {
    evt = wh.verify(rawPayload, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    });
    console.log("[Clerk Webhook Handler File] Svix signature verification successful.");
  } catch (err) {
    console.error("[Clerk Webhook Handler File] Error verifying Svix webhook signature:", err.message);
    if (err.stack) {
      console.error("[Clerk Webhook Handler File] Svix verification error stack:", err.stack);
    }
    return res.status(400).send("Error occurred -- webhook signature verification failed.");
  }

  const eventType = evt.type;
  const eventData = evt.data;
  console.log(`[Clerk Webhook Handler File] Processing verified event of type: ${eventType}`);

  try {
    if (eventType === 'user.created' || eventType === 'user.updated') {
      console.log(`[Clerk Webhook Handler File] Event data for ${eventType}:`, JSON.stringify(eventData, null, 2));
      const { id, email_addresses, first_name, last_name, image_url, public_metadata } = eventData;

      if (!id) {
        console.error("[Clerk Webhook Handler File] Error: Clerk User ID (id) is missing in event data.");
        return res.status(400).send("Clerk User ID missing in webhook data.");
      }

      const primaryEmailObj = email_addresses?.find(emailObj => emailObj.id === eventData.primary_email_address_id);
      const email = primaryEmailObj ? primaryEmailObj.email_address : null;

      if (!email && eventType === 'user.created') { // Ser mais estrito para user.created
        console.warn("[Clerk Webhook Handler File] Warning: Primary email address not found for new user:", id);
        // Pode ser um problema se o email for obrigatório no seu sistema
      }
      
      const profileData = {
        id: id,
        email: email,
        full_name: `${first_name || ''} ${last_name || ''}`.trim() || null,
        avatar_url: image_url || null,
        clerk_raw_data: eventData,
      };

      Object.keys(profileData).forEach(key => {
        if (profileData[key] === null || typeof profileData[key] === 'undefined') {
          delete profileData[key];
        }
      });
      
      if (eventType === 'user.created') {
        profileData.created_at = new Date(eventData.created_at || Date.now()).toISOString();
        profileData.updated_at = new Date(eventData.created_at || Date.now()).toISOString(); //  Para user.created, updated_at é o mesmo que created_at

        console.log("[Clerk Webhook Handler File] Attempting to insert new user profile:", JSON.stringify(profileData, null, 2));
        const { data, error } = await supabase.from('profiles').insert(profileData).select();

        if (error) {
          console.error("[Clerk Webhook Handler File] Error inserting user profile:", JSON.stringify(error, null, 2));
          // Não retornar 500 para o Clerk para evitar retentativas por erros de DB que podem não ser culpa deles
          // Mas precisamos de um status de erro se a operação falhar.
          // O Clerk espera 2xx para sucesso. Um 4xx ou 5xx pode causar retentativas.
          // Se for um erro de duplicação de chave (usuário já existe), um 409 seria apropriado mas svix não re-tenta em 409.
          // Para outros erros de DB, um 500 interno ao Clerk não é ideal.
          // Melhor logar e responder 200 para evitar retentativas do Clerk, mas o erro interno foi logado.
        } else {
          console.log("[Clerk Webhook Handler File] User profile successfully inserted:", JSON.stringify(data, null, 2));
        }
      } else { // user.updated
        profileData.updated_at = new Date(eventData.updated_at || Date.now()).toISOString();
        
        console.log("[Clerk Webhook Handler File] Attempting to update user profile:", JSON.stringify(profileData, null, 2));
        const { data, error } = await supabase.from('profiles').update(profileData).eq('id', id).select();

        if (error) {
          console.error("[Clerk Webhook Handler File] Error updating user profile:", JSON.stringify(error, null, 2));
          if (error.code === 'PGRST116') { 
               console.warn(`[Clerk Webhook Handler File] User profile not found for update (ID: ${id}).`);
          }
        } else {
          if (data && data.length > 0) {
            console.log("[Clerk Webhook Handler File] User profile successfully updated:", JSON.stringify(data, null, 2));
          } else {
            console.warn(`[Clerk Webhook Handler File] User profile not found for update (ID: ${id}), or no changes made.`);
             // Tentar inserir se não foi encontrado para atualização (upsert manual)
            console.log("[Clerk Webhook Handler File] Attempting to insert profile as it was not found for update.");
            profileData.created_at = new Date(eventData.updated_at || Date.now()).toISOString(); // Usar updated_at como created_at se for novo
            const { data: insertData, error: insertError } = await supabase.from('profiles').insert(profileData).select();
            if (insertError) {
              console.error("[Clerk Webhook Handler File] Error inserting profile during update fallback:", JSON.stringify(insertError, null, 2));
            } else {
              console.log("[Clerk Webhook Handler File] User profile successfully inserted during update fallback:", JSON.stringify(insertData, null, 2));
            }
          }
        }
      }
    } else if (eventType === 'user.deleted') {
      console.log(`[Clerk Webhook Handler File] Event data for ${eventType}:`, JSON.stringify(eventData, null, 2));
      const { id } = eventData;
      if (!id) {
        console.error("[Clerk Webhook Handler File] Error: Clerk User ID (id) is missing in user.deleted event data.");
        return res.status(400).send("Clerk User ID missing in webhook data for deletion.");
      }
      
      console.log("[Clerk Webhook Handler File] Attempting to delete user profile with ID:", id);
      const { error } = await supabase.from('profiles').delete().eq('id', id);

      if (error) {
        console.error("[Clerk Webhook Handler File] Error deleting user profile:", JSON.stringify(error, null, 2));
      } else {
        console.log("[Clerk Webhook Handler File] User profile successfully deleted for ID:", id);
      }
    } else {
      console.log(`[Clerk Webhook Handler File] Received unhandled event type: ${eventType}`);
    }
  } catch (dbError) {
    console.error("[Clerk Webhook Handler File] Database/Operation error:", dbError);
    // Para o Clerk, é melhor responder 200 para evitar retentativas por erros que não são culpa deles,
    // desde que o erro tenha sido logado para investigação.
  }

  res.status(200).json({ received: true, message: "Webhook processed by handler file." });
}

export default handleClerkWebhook; 