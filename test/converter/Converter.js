const { expect } = require('chai');
const { ethers } = require('hardhat');
const { BigNumber } = require('ethers');

const { NATIVE_TOKEN_ADDRESS, ZERO_ADDRESS, registry } = require('../helpers/Constants');

const Contracts = require('../helpers/Contracts');

let bancorNetwork;
let factory;
let anchor;
let anchorAddress;
let contractRegistry;
let reserveToken;
let reserveToken2;
let upgrader;

let owner;
let nonOwner;
let receiver;

let accounts;

describe('Converter', () => {
    const createConverter = async (
        type,
        anchorAddress,
        registryAddress = contractRegistry.address,
        maxConversionFee = 0
    ) => {
        switch (type) {
            case 3:
                return Contracts.StandardPoolConverter.deploy(anchorAddress, registryAddress, maxConversionFee);
            default:
                throw new Error(`Unsupported type ${type}`);
        }
    };

    const getConverterName = (type) => {
        switch (type) {
            case 3:
                return 'StandardPoolConverter';
            default:
                throw new Error(`Unsupported type ${type}`);
        }
    };

    const initConverter = async (type, activate, isETHReserve, maxConversionFee = 0) => {
        await createAnchor();
        const reserveAddresses = [getReserve1Address(isETHReserve), reserveToken2.address];
        const reserveWeights = [500000, 500000];

        const converter = await createConverter(type, anchorAddress, contractRegistry.address, maxConversionFee);

        for (let i = 0; i < reserveAddresses.length; i++) {
            await converter.addReserve(reserveAddresses[i], reserveWeights[i]);
        }

        if (type === 4) {
            await converter.setRate(1, 1);
        }

        await reserveToken2.transfer(converter.address, 8000);
        await anchor.issue(owner.address, 20000);

        if (isETHReserve) {
            await owner.sendTransaction({ to: converter.address, value: 5000 });
        } else {
            await reserveToken.transfer(converter.address, 5000);
        }

        if (activate) {
            await anchor.transferOwnership(converter.address);
            await converter.acceptAnchorOwnership();
        }

        return converter;
    };

    const createAnchor = async () => {
        anchor = await Contracts.DSToken.deploy('Pool1', 'POOL1', 2);
        anchorAddress = anchor.address;
    };

    const getReserve1Address = (isETH) => {
        return isETH ? NATIVE_TOKEN_ADDRESS : reserveToken.address;
    };

    const convert = async (path, amount, minReturn, options = undefined) => {
        if (options !== undefined) {
            return await bancorNetwork.convertByPath2(path, amount, minReturn, ZERO_ADDRESS, options);
        }
        return await bancorNetwork.convertByPath2(path, amount, minReturn, ZERO_ADDRESS);
    };

    const MIN_RETURN = BigNumber.from(1);
    const WEIGHT_10_PERCENT = BigNumber.from(100000);
    const MAX_CONVERSION_FEE = BigNumber.from(200000);

    before(async () => {
        accounts = await ethers.getSigners();

        owner = accounts[0];
        nonOwner = accounts[1];
        receiver = accounts[3];

        // The following contracts are unaffected by the underlying tests, this can be shared.
        contractRegistry = await Contracts.ContractRegistry.deploy();

        factory = await Contracts.ConverterFactory.deploy();
        await contractRegistry.registerAddress(registry.CONVERTER_FACTORY, factory.address);

        const networkSettings = await Contracts.NetworkSettings.deploy(owner.address, 0);
        await contractRegistry.registerAddress(registry.NETWORK_SETTINGS, networkSettings.address);

        await factory.registerTypedConverterFactory((await Contracts.StandardPoolConverterFactory.deploy()).address);
    });

    beforeEach(async () => {
        bancorNetwork = await Contracts.BancorNetwork.deploy(contractRegistry.address);
        await contractRegistry.registerAddress(registry.BANCOR_NETWORK, bancorNetwork.address);

        upgrader = await Contracts.ConverterUpgrader.deploy(contractRegistry.address);
        await contractRegistry.registerAddress(registry.CONVERTER_UPGRADER, upgrader.address);

        reserveToken = await Contracts.TestStandardToken.deploy('ERC Token 1', 'ERC1', 18, 1000000000);
        reserveToken2 = await Contracts.TestNonStandardToken.deploy('ERC Token 2', 'ERC2', 18, 2000000000);
    });

    for (const type of [3]) {
        it('verifies that converterType returns the correct type', async () => {
            const converter = await initConverter(type, true, true);
            const converterType = await converter.converterType();
            expect(converterType).to.equal(BigNumber.from(type));
        });

        it('verifies that sending ether to the converter succeeds if it has ETH reserve', async () => {
            const converter = await initConverter(type, true, true);
            await owner.sendTransaction({ to: converter.address, value: 100 });
        });

        it('should revert when sending ether to the converter fails if it has no ETH reserve', async () => {
            const converter = await initConverter(type, true, false);
            await expect(owner.sendTransaction({ to: converter.address, value: 100 })).to.be.revertedWith(
                'ERR_INVALID_RESERVE'
            );
        });

        for (let isETHReserve = 0; isETHReserve < 2; isETHReserve++) {
            describe(`${getConverterName(type)}${isETHReserve === 0 ? '' : ' (with ETH reserve)'}:`, () => {
                it('verifies the converter data after construction', async () => {
                    const converter = await initConverter(type, false, isETHReserve);
                    const anchor = await converter.anchor();
                    expect(anchor).to.equal(anchorAddress);

                    const registry = await converter.registry();
                    expect(registry).to.equal(contractRegistry.address);

                    const maxConversionFee = await converter.maxConversionFee();
                    expect(maxConversionFee).to.equal(BigNumber.from(0));
                });

                it('should revert when attempting to construct a converter with no anchor', async () => {
                    await expect(createConverter(type, ZERO_ADDRESS)).to.be.revertedWith('ERR_INVALID_ADDRESS');
                });

                it('should revert when attempting to construct a converter with no contract registry', async () => {
                    await expect(createConverter(type, anchorAddress, ZERO_ADDRESS)).to.be.revertedWith(
                        'ERR_INVALID_ADDRESS'
                    );
                });

                it('should revert when attempting to construct a converter with invalid conversion fee', async () => {
                    await expect(
                        createConverter(type, anchorAddress, contractRegistry.address, 1000001)
                    ).to.be.revertedWith('ERR_INVALID_CONVERSION_FEE');
                });

                it('verifies that the converter registry can create a new converter', async () => {
                    const converterRegistry = await Contracts.ConverterRegistry.deploy(contractRegistry.address);
                    const converterRegistryData = await Contracts.ConverterRegistryData.deploy(
                        contractRegistry.address
                    );

                    await contractRegistry.registerAddress(registry.CONVERTER_REGISTRY, converterRegistry.address);
                    await contractRegistry.registerAddress(
                        registry.CONVERTER_REGISTRY_DATA,
                        converterRegistryData.address
                    );

                    await converterRegistry.newConverter(
                        type,
                        'test',
                        'TST',
                        2,
                        1000,
                        [getReserve1Address(isETHReserve), reserveToken2.address],
                        [500000, 500000]
                    );
                });

                if (type !== 3 && type !== 4) {
                    it('verifies the owner can update the conversion whitelist contract address', async () => {
                        const converter = await initConverter(type, false, isETHReserve);
                        const prevWhitelist = await converter.conversionWhitelist();

                        await converter.setConversionWhitelist(receiver.address);

                        const newWhitelist = await converter.conversionWhitelist();
                        expect(prevWhitelist).not.to.equal(newWhitelist);
                    });

                    it('should revert when a non owner attempts update the conversion whitelist contract address', async () => {
                        const converter = await initConverter(type, false, isETHReserve);

                        await expect(
                            converter.connect(nonOwner).setConversionWhitelist(receiver.address)
                        ).to.be.revertedWith('ERR_ACCESS_DENIED');
                    });

                    it('verifies the owner can remove the conversion whitelist contract address', async () => {
                        const converter = await initConverter(type, false, isETHReserve);
                        await converter.setConversionWhitelist(receiver.address);

                        let whitelist = await converter.conversionWhitelist();
                        expect(whitelist).to.equal(receiver.address);

                        await converter.setConversionWhitelist(ZERO_ADDRESS);
                        whitelist = await converter.conversionWhitelist();

                        expect(whitelist).to.equal(ZERO_ADDRESS);
                    });
                }

                it('verifies the owner can update the fee', async () => {
                    const converter = await initConverter(type, false, isETHReserve, MAX_CONVERSION_FEE);

                    const newFee = MAX_CONVERSION_FEE.sub(BigNumber.from(10));
                    await converter.setConversionFee(newFee);

                    const conversionFee = await converter.conversionFee();
                    expect(conversionFee).to.equal(newFee);
                });

                it('should revert when attempting to update the fee to an invalid value', async () => {
                    const converter = await initConverter(type, false, isETHReserve, MAX_CONVERSION_FEE);

                    await expect(
                        converter.setConversionFee(MAX_CONVERSION_FEE.add(BigNumber.from(1)))
                    ).to.be.revertedWith('ERR_INVALID_CONVERSION_FEE');
                });

                it('should revert when a non owner attempts to update the fee', async () => {
                    const converter = await initConverter(type, false, isETHReserve, MAX_CONVERSION_FEE);

                    const newFee = BigNumber.from(30000);
                    await expect(converter.connect(nonOwner).setConversionFee(newFee)).to.be.revertedWith(
                        'ERR_ACCESS_DENIED'
                    );
                });

                it('verifies that an event is fired when the owner updates the fee', async () => {
                    const converter = await initConverter(type, false, isETHReserve, MAX_CONVERSION_FEE);

                    const newFee = BigNumber.from(30000);

                    await expect(await converter.setConversionFee(newFee))
                        .to.emit(converter, 'ConversionFeeUpdate')
                        .withArgs(BigNumber.from(0), newFee);
                });

                it('verifies that an event is fired when the owner updates the fee multiple times', async () => {
                    const converter = await initConverter(type, false, isETHReserve, MAX_CONVERSION_FEE);

                    let prevFee = BigNumber.from(0);
                    for (let i = 1; i <= 10; ++i) {
                        const newFee = BigNumber.from(10000 * i);

                        await expect(await converter.setConversionFee(newFee))
                            .to.emit(converter, 'ConversionFeeUpdate')
                            .withArgs(prevFee, newFee);

                        prevFee = newFee;
                    }
                });

                if (type !== 3 && type !== 4) {
                    it('should revert when a non owner attempts to add a reserve', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);

                        await expect(
                            converter.connect(nonOwner).addReserve(getReserve1Address(isETHReserve), WEIGHT_10_PERCENT)
                        ).to.be.revertedWith('ERR_ACCESS_DENIED');
                    });

                    it('should revert when attempting to add a reserve with invalid address', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);

                        await expect(converter.addReserve(ZERO_ADDRESS, WEIGHT_10_PERCENT)).to.be.revertedWith(
                            'ERR_INVALID_EXTERNAL_ADDRESS'
                        );
                    });

                    it('should revert when attempting to add a reserve with weight = 0', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);

                        await expect(converter.addReserve(getReserve1Address(isETHReserve), 0)).to.be.revertedWith(
                            'ERR_INVALID_RESERVE_WEIGHT'
                        );
                    });

                    it('should revert when attempting to add a reserve with weight greater than 100%', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);

                        await expect(
                            converter.addReserve(getReserve1Address(isETHReserve), 1000001)
                        ).to.be.revertedWith('ERR_INVALID_RESERVE_WEIGHT');
                    });

                    it('should revert when attempting to add the anchor as a reserve', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);

                        await expect(converter.addReserve(anchorAddress, WEIGHT_10_PERCENT)).to.be.revertedWith(
                            'ERR_INVALID_RESERVE'
                        );
                    });

                    it('verifies that the correct reserve weight is returned', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);
                        await converter.addReserve(getReserve1Address(isETHReserve), WEIGHT_10_PERCENT);

                        const reserveWeight = await converter.reserveWeight(getReserve1Address(isETHReserve));
                        expect(reserveWeight).to.equal(WEIGHT_10_PERCENT);
                    });

                    it('should revert when attempting to retrieve the balance for a reserve that does not exist', async () => {
                        await createAnchor();
                        const converter = await createConverter(type, anchorAddress);
                        await converter.addReserve(getReserve1Address(isETHReserve), WEIGHT_10_PERCENT);

                        await expect(converter.reserveBalance(reserveToken2.address)).to.be.revertedWith(
                            'ERR_INVALID_RESERVE'
                        );
                    });
                }

                it('verifies that the converter can accept the anchor ownership', async () => {
                    const converter = await initConverter(type, false, isETHReserve);
                    await anchor.transferOwnership(converter.address);
                    await converter.acceptAnchorOwnership();

                    expect(await anchor.owner()).to.equal(converter.address);
                });

                it('should revert when attempting to accept an anchor ownership of a converter without any reserves', async () => {
                    await createAnchor();
                    const converter = await createConverter(type, anchorAddress);

                    await anchor.transferOwnership(converter.address);
                    await expect(converter.acceptAnchorOwnership()).to.be.revertedWith('ERR_INVALID_RESERVE_COUNT');
                });

                it('verifies that the owner can transfer the anchor ownership if the owner is the upgrader contract', async () => {
                    const converter = await initConverter(type, true, isETHReserve);

                    await contractRegistry.registerAddress(registry.CONVERTER_UPGRADER, owner.address);

                    await converter.transferAnchorOwnership(nonOwner.address);

                    await contractRegistry.registerAddress(registry.CONVERTER_UPGRADER, upgrader.address);
                    const anchorAddress = await converter.anchor();
                    const token = await Contracts.DSToken.attach(anchorAddress);
                    const newOwner = await token.newOwner();
                    expect(newOwner).to.equal(nonOwner.address);
                });

                it('should revert when the owner attempts to transfer the anchor ownership', async () => {
                    const converter = await initConverter(type, true, isETHReserve);

                    await expect(converter.transferAnchorOwnership(nonOwner.address)).to.be.revertedWith(
                        'ERR_ACCESS_DENIED'
                    );
                });

                it('should revert when a non owner attempts to transfer the anchor ownership', async () => {
                    const converter = await initConverter(type, true, isETHReserve);

                    await expect(
                        converter.connect(nonOwner).transferAnchorOwnership(nonOwner.address)
                    ).to.be.revertedWith('ERR_ACCESS_DENIED');
                });

                // eslint-disable-next-line max-len
                it('should revert when a the upgrader contract attempts to transfer the anchor ownership while the upgrader is not the owner', async () => {
                    const converter = await initConverter(type, true, isETHReserve);
                    await contractRegistry.registerAddress(registry.CONVERTER_UPGRADER, nonOwner.address);

                    await expect(
                        converter.connect(nonOwner).transferAnchorOwnership(nonOwner.address)
                    ).to.be.revertedWith('ERR_ACCESS_DENIED');
                });

                it('verifies that isActive returns true when the converter is active', async () => {
                    const converter = await initConverter(type, true, isETHReserve);
                    const isActive = await converter.isActive();
                    expect(isActive).to.be.true;
                });

                it('verifies that isActive returns false when the converter is inactive', async () => {
                    const converter = await initConverter(type, false, isETHReserve);
                    const isActive = await converter.isActive();
                    expect(isActive).to.be.false;
                });

                it('verifies that the owner can upgrade the converter while the converter is active', async () => {
                    const converter = await initConverter(type, true, isETHReserve);
                    await converter.upgrade();
                });

                it('verifies that the owner can upgrade the converter while the converter is not active', async () => {
                    const converter = await initConverter(type, false, isETHReserve);
                    await converter.upgrade();
                });

                it('should revert when a non owner attempts to upgrade the converter', async () => {
                    const converter = await initConverter(type, true, isETHReserve);
                    await expect(converter.connect(nonOwner).upgrade()).to.be.revertedWith('ERR_ACCESS_DENIED');
                });

                it('should revert when attempting to get the target amount with an invalid source token address', async () => {
                    const converter = await initConverter(type, true, isETHReserve);

                    await expect(
                        converter.targetAmountAndFee(ZERO_ADDRESS, getReserve1Address(isETHReserve), 500)
                    ).to.be.revertedWith('ERR_INVALID_RESERVE');
                });

                it('should revert when attempting to get the target amount with an invalid target token address', async () => {
                    const converter = await initConverter(type, true, isETHReserve);

                    await expect(
                        converter.targetAmountAndFee(getReserve1Address(isETHReserve), ZERO_ADDRESS, 500)
                    ).to.be.revertedWith('ERR_INVALID_RESERVE');
                });

                it('should revert when attempting to get the target amount with identical source/target addresses', async () => {
                    const converter = await initConverter(type, true, isETHReserve);

                    await expect(
                        converter.targetAmountAndFee(
                            getReserve1Address(isETHReserve),
                            getReserve1Address(isETHReserve),
                            500
                        )
                    ).to.be.revertedWith('ERR_INVALID_RESERVES');
                });

                it('should revert when attempting to convert with an invalid source token address', async () => {
                    await initConverter(type, true, isETHReserve);
                    await expect(
                        convert([ZERO_ADDRESS, anchorAddress, getReserve1Address(isETHReserve)], 500, MIN_RETURN)
                    ).to.be.revertedWith('Address: call to non-contract');
                });

                it('should revert when attempting to convert with an invalid target token address', async () => {
                    await initConverter(type, true, isETHReserve);

                    const amount = BigNumber.from(500);
                    let value = 0;
                    if (isETHReserve) {
                        value = amount;
                    } else {
                        await reserveToken.connect(owner).approve(bancorNetwork.address, amount);
                    }

                    await expect(
                        convert([getReserve1Address(isETHReserve), anchorAddress, ZERO_ADDRESS], amount, MIN_RETURN, {
                            value: value
                        })
                    ).to.be.revertedWith('ERR_INVALID_RESERVE');
                });

                it('should revert when attempting to convert with identical source/target addresses', async () => {
                    await initConverter(type, true, isETHReserve);

                    const amount = BigNumber.from(500);
                    let value = 0;
                    if (isETHReserve) {
                        value = amount;
                    } else {
                        await reserveToken.connect(owner).approve(bancorNetwork.address, amount);
                    }

                    await expect(
                        convert(
                            [getReserve1Address(isETHReserve), anchorAddress, getReserve1Address(isETHReserve)],
                            amount,
                            MIN_RETURN,
                            { value }
                        )
                    ).to.be.revertedWith('ERR_SAME_SOURCE_TARGET');
                });
            });
        }
    }
});
