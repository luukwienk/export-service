-- CreateTable
CREATE TABLE "Woonplaats" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "naam" TEXT NOT NULL,

    CONSTRAINT "Woonplaats_pkey" PRIMARY KEY ("identificatie")
);

-- CreateTable
CREATE TABLE "OpenbareRuimte" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "naam" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "woonplaatsId" TEXT NOT NULL,

    CONSTRAINT "OpenbareRuimte_pkey" PRIMARY KEY ("identificatie")
);

-- CreateTable
CREATE TABLE "Pand" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "oorspronkelijkBouwjaar" INTEGER NOT NULL,

    CONSTRAINT "Pand_pkey" PRIMARY KEY ("identificatie")
);

-- CreateTable
CREATE TABLE "Nummeraanduiding" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "huisnummer" INTEGER NOT NULL,
    "huisletter" TEXT,
    "huisnummertoevoeging" TEXT,
    "postcode" TEXT,
    "type" TEXT NOT NULL,
    "openbareRuimteId" TEXT NOT NULL,

    CONSTRAINT "Nummeraanduiding_pkey" PRIMARY KEY ("identificatie")
);

-- CreateTable
CREATE TABLE "Verblijfsobject" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "rd_x" DOUBLE PRECISION,
    "rd_y" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "latitude" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "gebruiksdoel" TEXT[],
    "oppervlakte" INTEGER NOT NULL,
    "nummeraanduidingId" TEXT NOT NULL,
    "pandId" TEXT NOT NULL,

    CONSTRAINT "Verblijfsobject_pkey" PRIMARY KEY ("identificatie")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NummeraanduidingStaging" (
    "id" SERIAL NOT NULL,
    "identificatie" TEXT NOT NULL,
    "huisnummer" INTEGER NOT NULL,
    "huisletter" TEXT,
    "huisnummertoevoeging" TEXT,
    "postcode" TEXT,
    "typeObject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "geconstateerd" BOOLEAN NOT NULL,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "tijdstipRegistratie" TIMESTAMP(3) NOT NULL,
    "openbareRuimteId" TEXT NOT NULL,
    "processingBatch" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NummeraanduidingStaging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ligplaats" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nummeraanduidingId" TEXT NOT NULL,

    CONSTRAINT "Ligplaats_pkey" PRIMARY KEY ("identificatie")
);

-- CreateTable
CREATE TABLE "Standplaats" (
    "identificatie" TEXT NOT NULL,
    "beginGeldigheid" TIMESTAMP(3) NOT NULL,
    "eindGeldigheid" TIMESTAMP(3),
    "geconstateerd" BOOLEAN NOT NULL DEFAULT false,
    "documentDatum" TIMESTAMP(3) NOT NULL,
    "documentNummer" TEXT NOT NULL,
    "geometry" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nummeraanduidingId" TEXT NOT NULL,

    CONSTRAINT "Standplaats_pkey" PRIMARY KEY ("identificatie")
);

-- CreateIndex
CREATE INDEX "idx_woonplaats_eind" ON "Woonplaats"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_woonplaats_naam" ON "Woonplaats"("naam");

-- CreateIndex
CREATE INDEX "idx_openbare_ruimte_eind" ON "OpenbareRuimte"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_openbare_ruimte_woonplaats" ON "OpenbareRuimte"("woonplaatsId");

-- CreateIndex
CREATE INDEX "idx_openbare_ruimte_naam" ON "OpenbareRuimte"("naam");

-- CreateIndex
CREATE INDEX "idx_pand_eind" ON "Pand"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_nummeraanduiding_eind" ON "Nummeraanduiding"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_nummeraanduiding_openbare_ruimte" ON "Nummeraanduiding"("openbareRuimteId");

-- CreateIndex
CREATE INDEX "idx_nummeraanduiding_postcode_huisnummer" ON "Nummeraanduiding"("postcode", "huisnummer");

-- CreateIndex
CREATE UNIQUE INDEX "Verblijfsobject_nummeraanduidingId_key" ON "Verblijfsobject"("nummeraanduidingId");

-- CreateIndex
CREATE INDEX "idx_verblijfsobject_longitude_latitude" ON "Verblijfsobject"("longitude", "latitude");

-- CreateIndex
CREATE INDEX "idx_verblijfsobject_eind" ON "Verblijfsobject"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_verblijfsobject_status" ON "Verblijfsobject"("status");

-- CreateIndex
CREATE INDEX "idx_verblijfsobject_nummeraanduiding" ON "Verblijfsobject"("nummeraanduidingId");

-- CreateIndex
CREATE INDEX "idx_verblijfsobject_pand" ON "Verblijfsobject"("pandId");

-- CreateIndex
CREATE UNIQUE INDEX "NummeraanduidingStaging_identificatie_key" ON "NummeraanduidingStaging"("identificatie");

-- CreateIndex
CREATE INDEX "NummeraanduidingStaging_processingBatch_idx" ON "NummeraanduidingStaging"("processingBatch");

-- CreateIndex
CREATE INDEX "NummeraanduidingStaging_processed_idx" ON "NummeraanduidingStaging"("processed");

-- CreateIndex
CREATE INDEX "NummeraanduidingStaging_postcode_huisnummer_idx" ON "NummeraanduidingStaging"("postcode", "huisnummer");

-- CreateIndex
CREATE INDEX "NummeraanduidingStaging_openbareRuimteId_idx" ON "NummeraanduidingStaging"("openbareRuimteId");

-- CreateIndex
CREATE UNIQUE INDEX "Ligplaats_nummeraanduidingId_key" ON "Ligplaats"("nummeraanduidingId");

-- CreateIndex
CREATE INDEX "idx_ligplaats_eind" ON "Ligplaats"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_ligplaats_status" ON "Ligplaats"("status");

-- CreateIndex
CREATE INDEX "idx_ligplaats_nummeraanduiding" ON "Ligplaats"("nummeraanduidingId");

-- CreateIndex
CREATE UNIQUE INDEX "Standplaats_nummeraanduidingId_key" ON "Standplaats"("nummeraanduidingId");

-- CreateIndex
CREATE INDEX "idx_standplaats_eind" ON "Standplaats"("eindGeldigheid");

-- CreateIndex
CREATE INDEX "idx_standplaats_status" ON "Standplaats"("status");

-- CreateIndex
CREATE INDEX "idx_standplaats_nummeraanduiding" ON "Standplaats"("nummeraanduidingId");

-- AddForeignKey
ALTER TABLE "OpenbareRuimte" ADD CONSTRAINT "OpenbareRuimte_woonplaatsId_fkey" FOREIGN KEY ("woonplaatsId") REFERENCES "Woonplaats"("identificatie") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nummeraanduiding" ADD CONSTRAINT "Nummeraanduiding_openbareRuimteId_fkey" FOREIGN KEY ("openbareRuimteId") REFERENCES "OpenbareRuimte"("identificatie") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verblijfsobject" ADD CONSTRAINT "Verblijfsobject_nummeraanduidingId_fkey" FOREIGN KEY ("nummeraanduidingId") REFERENCES "Nummeraanduiding"("identificatie") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verblijfsobject" ADD CONSTRAINT "Verblijfsobject_pandId_fkey" FOREIGN KEY ("pandId") REFERENCES "Pand"("identificatie") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ligplaats" ADD CONSTRAINT "Ligplaats_nummeraanduidingId_fkey" FOREIGN KEY ("nummeraanduidingId") REFERENCES "Nummeraanduiding"("identificatie") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Standplaats" ADD CONSTRAINT "Standplaats_nummeraanduidingId_fkey" FOREIGN KEY ("nummeraanduidingId") REFERENCES "Nummeraanduiding"("identificatie") ON DELETE RESTRICT ON UPDATE CASCADE;
