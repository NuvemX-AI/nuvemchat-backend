-- CreateTable
CREATE TABLE "WhatsappIntegration" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sessionData" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappIntegration_instanceId_key" ON "WhatsappIntegration"("instanceId");
