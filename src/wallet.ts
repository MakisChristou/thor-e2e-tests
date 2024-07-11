import {
    addressUtils,
    secp256k1,
    Transaction,
    TransactionBody,
    TransactionClause,
} from '@vechain/sdk-core'
import { delegateTx, fundAccount } from './account-faucet'
import {
    generateNonce,
    pollReceipt,
    warnIfSimulationFails,
} from './transactions'
import { getBlockRef } from './utils/block-utils'
import { components } from './open-api-types'
import { Node1Client, SDKClient } from './thor-client'
import { Abi } from 'abitype'
import {
    ProviderInternalBaseWallet,
    VeChainPrivateKeySigner,
    VeChainProvider,
} from '@vechain/sdk-network'

export const generateAddress = () => {
    return generateEmptyWallet().address
}

export const generateAddresses = (count: number) => {
    return Array.from({ length: count }, () => generateEmptyWallet().address)
}

export const addressFromPrivateKey = (privateKey: Buffer) => {
    return addressUtils.fromPrivateKey(privateKey).toLowerCase()
}

const generateEmptyWallet = () => {
    const privateKey = Buffer.from(secp256k1.generatePrivateKey())
    const addr = addressUtils.fromPrivateKey(privateKey).toLowerCase()

    return {
        privateKey: privateKey.toString('hex'),
        address: addr,
    }
}

type WaitForFunding = () => Promise<
    components['schemas']['GetTxReceiptResponse'] | undefined
>

class ThorWallet {
    public readonly address: string
    public readonly privateKey: Buffer
    public readonly waitForFunding: WaitForFunding

    public provider: VeChainProvider
    public signer: VeChainPrivateKeySigner

    constructor(privateKey: Buffer, waitForFunding?: WaitForFunding) {
        this.privateKey = privateKey
        this.address = addressFromPrivateKey(privateKey)
        if (waitForFunding) {
            this.waitForFunding = waitForFunding
        } else {
            this.waitForFunding = () => Promise.resolve(undefined)
        }
        this.provider = new VeChainProvider(
            SDKClient,
            new ProviderInternalBaseWallet([
                {
                    address: this.address,
                    privateKey: this.privateKey,
                },
            ]),
        )
        this.signer = new VeChainPrivateKeySigner(
            this.privateKey,
            this.provider,
        )
    }

    public static new(requireFunds: boolean) {
        const privateKey = secp256k1.generatePrivateKey()

        if (!requireFunds) {
            return new ThorWallet(Buffer.from(privateKey))
        }

        const addr = addressUtils.fromPrivateKey(privateKey)

        const receipt = fundAccount(addr).then((res) => res.receipt)

        return new ThorWallet(Buffer.from(privateKey), () => receipt)
    }

    public deployContract = async <TAbi extends Abi>(
        bytecode: string,
        abi: TAbi,
    ) => {
        await this.waitForFunding()

        const factory = SDKClient.contracts.createContractFactory(
            abi,
            bytecode,
            this.signer,
        )

        await factory.startDeployment()

        return await factory.waitForDeployment()
    }

    public buildTransaction = async (
        clauses: TransactionClause[],
    ): Promise<TransactionBody> => {
        const bestBlockRef = await getBlockRef('best')
        const genesisBlock = await Node1Client.getBlock('0')

        if (!genesisBlock.success || !genesisBlock.body?.id) {
            throw new Error('Could not get best block')
        }

        return {
            blockRef: bestBlockRef,
            expiration: 1000,
            clauses: clauses,
            gasPriceCoef: 0,
            gas: 1_000_000,
            dependsOn: null,
            nonce: generateNonce(),
            chainTag: parseInt(genesisBlock.body.id.slice(-2), 16),
        }
    }

    public signTransaction = async (
        transaction: Transaction,
        delegationSignature?: Buffer,
    ) => {
        const signingHash = transaction.getSignatureHash()
        const signature = Buffer.from(
            secp256k1.sign(signingHash, this.privateKey),
        )

        let tx: Transaction

        if (delegationSignature) {
            tx = new Transaction(
                transaction.body,
                Buffer.concat([signature, delegationSignature]),
            )
        } else {
            tx = new Transaction(transaction.body, signature)
        }

        return tx
    }

    public signAndEncodeTx = async (
        transaction: Transaction,
        delegationSignature?: Buffer,
    ) => {
        const tx = await this.signTransaction(transaction, delegationSignature)

        return tx.encoded.toString('hex')
    }

    public sendClauses = async <T extends boolean>(
        clauses: TransactionClause[],
        waitForReceipt: T,
        delegate?: boolean,
    ): Promise<
        T extends true
            ? components['schemas']['GetTxReceiptResponse']
            : components['schemas']['TXID']
    > => {
        await this.waitForFunding()

        const transaction = await this.buildTransaction(clauses)
        let encoded: string

        await warnIfSimulationFails(clauses, this.address)

        if (delegate) {
            const delegated = delegateTx(transaction, this.address)
            encoded = await this.signAndEncodeTx(
                delegated.transaction,
                delegated.signature,
            )
        } else {
            const tx = new Transaction(transaction)

            encoded = await this.signAndEncodeTx(tx)
        }

        const res = await Node1Client.sendTransaction({
            raw: `0x${encoded}`,
        })

        if (!res.success) {
            throw new Error(
                JSON.stringify({
                    httpCode: res.httpCode,
                    message:
                        res.httpMessage ?? 'Unknown Error sending transaction',
                }),
            )
        }

        if (!waitForReceipt) {
            return res.body as components['schemas']['TXID'] as any
        }

        const receipt = await pollReceipt(res.body?.id ?? '')

        if (receipt.reverted) {
            console.error(
                'Transaction reverted',
                JSON.stringify(receipt, null, 2),
            )
        }

        return receipt as components['schemas']['GetTxReceiptResponse'] as any
    }
}

export { ThorWallet }
