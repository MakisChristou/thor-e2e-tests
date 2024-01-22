import { Node1Client } from '../../../src/thor-client'
import { contractAddresses } from '../../../src/contracts/addresses'
import { HEX_AT_LEAST_1 } from '../../../src/utils/hex-utils'
import {
    generateEmptyWallet,
    generateWalletWithFunds,
    Wallet,
} from '../../../src/wallet'
import { sendClauses } from '../../../src/transactions'
import { SimpleCounter__factory } from '../../../typechain-types'
import { revisions } from '../../../src/constants'

describe('GET /accounts/{address}/code', function () {
    const accountAddress = [
        generateEmptyWallet(),
        generateEmptyWallet(),
        generateEmptyWallet(),
        generateEmptyWallet(),
    ].map((w) => w.address)

    let wallet: Wallet

    beforeAll(async () => {
        wallet = await generateWalletWithFunds()
    })

    it.each(accountAddress)(
        'should return no code for newly created address: %s',
        async function (addr) {
            const res = await Node1Client.getAccountCode(addr)

            expect(res.success).toBeTruthy()
            expect(res.httpCode).toEqual(200)
            expect(res.body).toEqual({
                code: '0x',
            })
        },
    )

    const noPrefix = Object.entries(contractAddresses).map(
        ([name, address]) => [name, address.slice(2)],
    )

    it.each([...Object.entries(contractAddresses), ...noPrefix])(
        'should return the code for %s: %s',
        async function (entry, address) {
            const res = await Node1Client.getAccountCode(address)

            expect(res.success).toEqual(true)
            expect(res.httpCode).toEqual(200)
            expect(res.body).toEqual({
                code: expect.stringMatching(HEX_AT_LEAST_1),
            })
        },
    )

    it.each([
        'bad address', //not hex
        '0x0001234', //too short
        '0', //too short
        false,
    ])(`should return 400 for invalid address: %s`, async function (addr) {
        const res = await Node1Client.getAccountCode(addr as string)

        expect(res.success).toEqual(false)
        expect(res.httpCode).toEqual(400)
    })

    it('should be able to query historic revisions', async () => {
        const txReceipt = await sendClauses(
            [
                {
                    to: null,
                    value: '0x0',
                    data: SimpleCounter__factory.bytecode,
                },
            ],
            wallet.privateKey,
            true,
        )

        const address = txReceipt.outputs[0].contractAddress as string

        expect(address).toBeTruthy()

        const code = await Node1Client.getAccountCode(address)

        // Check the bytecode is not equal to 0x
        expect(code.body).toEqual({
            code: expect.stringMatching(HEX_AT_LEAST_1),
        })

        const codeForRevision = await Node1Client.getAccountCode(
            address,
            `${(txReceipt.meta.blockNumber ?? 1) - 1}`,
        )

        // Check the bytecode is equal to 0x for the previous revision
        expect(codeForRevision.body?.code).toBeTruthy()
        expect(codeForRevision.body).toEqual({
            code: '0x',
        })
    })

    it.each(revisions.valid())(
        'should be able to fetch the account state for revision: %s',
        async (revision) => {
            const vtho = await Node1Client.getAccountCode(
                contractAddresses.energy,
                revision,
            )

            expect(vtho.success).toEqual(true)
            expect(vtho.httpCode).toEqual(200)
            expect(vtho.body).toEqual({
                code: expect.stringMatching(HEX_AT_LEAST_1),
            })
        },
    )

    it.each(revisions.invalid)(
        'should throw an error for invalid revision: %s',
        async (revision) => {
            const vtho = await Node1Client.getAccountCode(
                contractAddresses.energy,
                revision,
            )

            expect(vtho.success).toEqual(false)
            expect(vtho.httpCode).toEqual(400)
        },
    )
})
